const express = require("express");
const adminRoutes = require("./routes/admin");
const app = express();
const port = process.env.PORT || 3000;
const cors = require("cors");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(cors({
  origin: ["http://localhost:3001", "http://192.168.18.52:3001"],
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true,
}));

app.use(require("./routes/auth"));
app.use(require("./routes/resident"));
app.use("/admin", adminRoutes);

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
