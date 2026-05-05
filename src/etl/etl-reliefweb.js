require("dotenv").config();

const { Client } = require("pg");
const { credentials } = require("./db");
const {
  getOrganizationId,
  upsertJobVacancy,
  safeApiCall,
} = require("./shared");

const BASE_URL = "https://api.reliefweb.int/v2/jobs";
const MAX_JOBS = 1000;
const PAGE_SIZE = 200;
const DATA_SOURCE = "reliefweb";
const ORG_NAME = "RELIEFWEB";

// Maps ReliefWeb career_categories → UN job-network (`jn`) names used by the
// hourly social-media crons in src/app.js. Without this map, ReliefWeb rows
// would never match the cron filter and wouldn't get posted.
const RELIEFWEB_CAREER_TO_JN = {
  "information technology": "Information and Telecommunication Technology",
  "information management": "Information and Telecommunication Technology",
  "information and communications technology (ict)":
    "Information and Telecommunication Technology",
  "advocacy/communications": "Communication",
  "media/public information": "Public Information and Conference Management",
  "donor relations/grants management": "Management and Administration",
  "administration/finance": "Management and Administration",
  "human resources": "Management and Administration",
  "logistics/procurement": "Logistics, Transportation and Supply Chain",
  "supply chain": "Logistics, Transportation and Supply Chain",
  "program/project management": "Health, Project Management, Programme Management",
  "monitoring and evaluation": "Health, Project Management, Programme Management",
  "health services": "Health, Project Management, Programme Management",
  "public health": "Health, Project Management, Programme Management",
  "medical/public health": "Health, Project Management, Programme Management",
  "humanitarian/emergency affairs": "Political, Peace and Humanitarian",
  "peace and conflict": "Political, Peace and Humanitarian",
  "protection and human rights": "Political, Peace and Humanitarian",
  "legal affairs": "Legal",
  "safety and security": "Internal Security and Safety",
  "research": "Science",
  "economic recovery and development": "Economic, Social and Development",
  "food security": "Economic, Social and Development",
  "livelihoods": "Economic, Social and Development",
};

const mapToJn = (reliefwebCategory) => {
  if (!reliefwebCategory || typeof reliefwebCategory !== "string") return "";
  const key = reliefwebCategory.trim().toLowerCase();
  return RELIEFWEB_CAREER_TO_JN[key] || reliefwebCategory;
};

const stripControlChars = (str) => {
  if (!str || typeof str !== "string") return "";
  return str.replace(/[\x00-\x08\x0E-\x1F]/g, "");
};

const buildDutyStation = (cities, countries) => {
  const cityNames = Array.isArray(cities)
    ? cities.map((c) => c?.name).filter(Boolean)
    : [];
  const countryNames = Array.isArray(countries)
    ? countries.map((c) => c?.name).filter(Boolean)
    : [];
  const parts = [...new Set([...cityNames, ...countryNames])];
  return parts.join(", ");
};

const parseDate = (raw) => {
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return undefined; // sentinel for invalid
  return d;
};

const seedReliefwebOrganization = async (client) => {
  try {
    await client.query(
      `INSERT INTO organization (name, code, short_name, long_name)
       SELECT 'ReliefWeb', 'RELIEFWEB', 'ReliefWeb', 'ReliefWeb'
       WHERE NOT EXISTS (
         SELECT 1 FROM organization
         WHERE name ILIKE 'ReliefWeb' OR code ILIKE 'RELIEFWEB'
       )`
    );
  } catch (error) {
    console.warn(
      `⚠️  ReliefWeb: organization seed failed (continuing with fallback id 128): ${error.message}`
    );
  }
};

const transformJob = (item) => {
  if (!item || !item.id) return null;
  const fields = item.fields || {};
  if (!fields.title) return null;

  const startDate = parseDate(fields?.date?.created);
  const endDate = parseDate(fields?.date?.closing);
  if (startDate === undefined || endDate === undefined) return null;

  const careerCategoryName = fields?.career_categories?.[0]?.name || "";
  const themeName = fields?.theme?.[0]?.name || "";
  const experienceName = fields?.experience?.[0]?.name || "";
  const typeName = fields?.type?.[0]?.name || "";
  const source0 = fields?.source?.[0] || {};
  const sourceName = source0.name || source0.shortname || "ReliefWeb";

  // Pick the best available logo URL from the source. ReliefWeb sometimes returns
  // a `logo` URL on the source object and sometimes only `homepage` — we want a
  // direct image URL so only `logo` is used. Empty string → null so we fall back.
  const rawLogo = typeof source0.logo === "string" ? source0.logo.trim() : "";
  const sourceLogoUrl = rawLogo && /^https?:\/\//i.test(rawLogo) ? rawLogo : null;

  const description = stripControlChars(
    fields["body-html"] || fields.body || ""
  );

  const applyLink = fields.url_alias || fields.url || "";

  return {
    job_id: String(item.id),
    language: "EN",
    category_code: careerCategoryName,
    job_title: String(fields.title).slice(0, 500),
    job_code_title: "",
    job_description: description,
    job_family_code: themeName,
    job_level: experienceName,
    duty_station: buildDutyStation(fields.city, fields.country),
    recruitment_type: typeName,
    start_date: startDate || null,
    end_date: endDate || null,
    dept: sourceName,
    total_count: null,
    jn: mapToJn(careerCategoryName),
    jf: themeName,
    jc: "",
    jl: experienceName,
    data_source: DATA_SOURCE,
    apply_link: applyLink,
    source_logo_url: sourceLogoUrl,
  };
};

const fetchPage = async (appname, offset) => {
  const params = new URLSearchParams({
    appname,
    preset: "latest",
    profile: "full",
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  const url = `${BASE_URL}?${params.toString()}`;
  // ReliefWeb returns 406 "Blocked due to bot activity" if the User-Agent
  // looks too custom; a curl-style UA passes their filter while the appname
  // query param still identifies us to their API.
  const result = await safeApiCall(
    url,
    {
      headers: {
        "User-Agent": "curl/8.0",
        Accept: "application/json",
      },
    },
    3,
    30000
  );
  if (!result.success) {
    throw new Error(result.error || "ReliefWeb API call failed");
  }
  return Array.isArray(result.data?.data) ? result.data.data : [];
};

async function fetchAndProcessReliefwebJobVacancies() {
  console.log("=========================================");
  console.log("ReliefWeb Job Vacancies ETL started...");
  console.log("=========================================");

  const appname = process.env.RELIEFWEB_APPNAME;
  if (!appname || !String(appname).trim()) {
    return {
      success: false,
      error: "RELIEFWEB_APPNAME not set",
      processedCount: 0,
      successCount: 0,
      errorCount: 0,
    };
  }

  const client = new Client(credentials);
  let processedCount = 0;
  let successCount = 0;
  let errorCount = 0;

  try {
    await client.connect();
    await seedReliefwebOrganization(client);

    let offset = 0;
    while (offset < MAX_JOBS) {
      const remaining = MAX_JOBS - offset;
      const pageItems = await fetchPage(appname, offset);

      if (pageItems.length === 0) break;

      const batch = pageItems.slice(0, remaining);
      for (const item of batch) {
        const jobData = transformJob(item);
        if (!jobData) {
          errorCount++;
          continue;
        }
        processedCount++;
        try {
          const orgId = await getOrganizationId(jobData.dept);
          jobData.organization_id = orgId;
          const upsertResult = await upsertJobVacancy(
            client,
            jobData,
            ORG_NAME
          );
          if (upsertResult.success) {
            successCount++;
          } else {
            errorCount++;
          }
        } catch (err) {
          errorCount++;
          console.warn(
            `⚠️  ReliefWeb: failed to upsert job ${jobData.job_id}: ${err.message}`
          );
        }
      }

      if (pageItems.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    console.log(
      `✅ ReliefWeb ETL completed: processed=${processedCount}, success=${successCount}, errors=${errorCount}`
    );

    return {
      success: true,
      processedCount,
      successCount,
      errorCount,
    };
  } catch (error) {
    console.error(`❌ ReliefWeb ETL failed: ${error.message}`);
    return {
      success: false,
      error: error.message,
      processedCount,
      successCount,
      errorCount,
    };
  } finally {
    try {
      await client.end();
    } catch (_) {
      /* swallow */
    }
  }
}

module.exports = {
  fetchAndProcessReliefwebJobVacancies,
};
