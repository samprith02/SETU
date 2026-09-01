// Setu — HTTP catalog API
//
// Deliberately thin: routing and status codes only. All product data and
// lookup logic lives in catalog.js, which the MCP server imports too, so the
// two surfaces can never drift apart.

import express from "express";
import { getCatalog, getProduct } from "./catalog.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/catalog", (req, res) => {
  res.json(getCatalog());
});

app.get("/product/:id", (req, res) => {
  const product = getProduct(req.params.id);
  if (product === null) {
    return res.status(404).json({ error: "product_not_found", id: req.params.id });
  }
  res.json(product);
});

app.listen(PORT, () => {
  console.log(`[setu] catalog API listening on http://localhost:${PORT}`);
});
