require("dotenv").config();

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "UN Jobs API",
      description: "API for UN Job Vacancies and Job Applications ",
       
      termsOfService: "https://www.unjobzone.com/privacy",
      contact: {
        name: "API Support",
        url: "https://api.unjobzone.com/api/v1/",
        email: "yyeneneh@unicef.org",
      },
      license: {
        name: "Apache 2.0",
        url: "https://www.apache.org/licenses/LICENSE-2.0.html",
      },
      version: "1.0.1",
      servers: ["http://localhost:3000"],
    },
    components: {
      securitySchemes: {
        Bearer: {
          type: "http",
          description: "Enter Authorization Bearer token ",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
    },
    security: [
      {
        Bearer: [],
      },
    ],
    servers: [
      {
        //url: "https://uni-connect-services.azurewebsites.net/"
        url: process.env.APP_URL,//"http://localhost:3000",
      },
    ],
  },
  apis: ["src/routers/*.js"],
};

module.exports = { options };
