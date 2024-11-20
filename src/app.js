const express = require("express");
const cors = require("cors");

const swaggerJsDoc = require("swagger-jsdoc");
const swaggerUi = require("swagger-ui-express");

const { options } = require("./util/swagger");

require("dotenv").config();

const PORT = process.env.PORT;

const errors = require("./error-middleware");

const router = require("./routers/index");
const app = express();

app.use(cors());
app.use(express.json());
app.use("/api/v1", router);



const swaggerSpec = swaggerJsDoc(options);

app.use("/api/v1", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app.use(errors.notFound);
app.use(errors.errorHandler);

app.listen(PORT, () => {
  console.log(`API Server is started on PORT: ${PORT}`);
});

