// Setu — product catalog
//
// Pure data + logic. Knows nothing about HTTP or MCP, so both the Express
// server (server-http.js) and the MCP server (server.js) import the same
// source of truth rather than each keeping their own copy.
//
// MONEY: every price is an integer count of paise, never a decimal rupee
// amount. Binary floating point cannot represent most decimal fractions
// exactly (0.1 + 0.2 === 0.30000000000000004), and that error is enough to
// flip a mandate cap comparison — the one decision this whole project is
// graded on. Razorpay's Orders API also takes integer paise, so this avoids
// converting at every boundary. Format to rupees only for display.

import { z } from "zod";

export const productSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  price: z.int().positive(), // paise — 149900 is Rs 1,499.00
  category: z.string().min(1),
  stock: z.int().nonnegative(),
  tags: z.array(z.string()).min(1),
  description: z.string().min(1),
});

// Fictional merchant: a campus tech-essentials store.
// Price spread is deliberate — a Rs 500 mandate cap allows the cables and
// stationery but blocks the charger and power bank, which is what makes the
// Day 2 over-limit failure scenario demonstrable without contrived numbers.
const PRODUCTS = [
  {
    id: "chg-usbc-65w",
    name: "65W USB-C Fast Charger",
    price: 149900,
    category: "chargers",
    stock: 24,
    tags: ["charger", "usb-c", "fast-charging", "laptop", "phone"],
    description: "65W GaN wall charger with a single USB-C PD port. Charges most laptops and phones.",
  },
  {
    id: "cbl-usbc-1m",
    name: "USB-C to USB-C Cable (1m)",
    price: 29900,
    category: "cables",
    stock: 80,
    tags: ["cable", "usb-c", "charging", "data"],
    description: "Braided 1-metre USB-C cable rated for 100W charging and USB 2.0 data transfer.",
  },
  {
    id: "acc-case-clear",
    name: "Clear Phone Case",
    price: 39900,
    category: "accessories",
    stock: 45,
    tags: ["case", "phone", "protection", "clear"],
    description: "Shock-absorbing transparent TPU case with raised camera and screen lips.",
  },
  {
    id: "aud-earphones-wired",
    name: "Wired Earphones with Mic",
    price: 59900,
    category: "audio",
    stock: 32,
    tags: ["earphones", "audio", "wired", "mic", "3.5mm"],
    description: "In-ear wired earphones with inline microphone and volume control. 3.5mm jack.",
  },
  {
    id: "acc-mouse-wireless",
    name: "Wireless Optical Mouse",
    price: 74900,
    category: "accessories",
    stock: 18,
    tags: ["mouse", "wireless", "laptop", "usb"],
    description: "2.4GHz wireless mouse with a nano USB receiver and 12-month battery life.",
  },
  {
    id: "sto-pendrive-64gb",
    name: "64GB USB 3.0 Pen Drive",
    price: 54900,
    category: "storage",
    stock: 40,
    tags: ["storage", "usb", "pendrive", "flash-drive", "64gb"],
    description: "64GB USB 3.0 flash drive with a retractable connector and metal housing.",
  },
  {
    id: "acc-sleeve-14",
    name: '14" Laptop Sleeve',
    price: 89900,
    category: "accessories",
    stock: 15,
    tags: ["sleeve", "laptop", "protection", "bag", "14-inch"],
    description: "Padded water-resistant sleeve for 14-inch laptops with a front accessory pocket.",
  },
  {
    id: "stn-notebook-a5",
    name: "A5 Ruled Notebook (200 pages)",
    price: 12000,
    category: "stationery",
    stock: 120,
    tags: ["notebook", "stationery", "ruled", "a5", "paper"],
    description: "200-page A5 ruled notebook with a stitched spine that lies flat when open.",
  },
  {
    id: "stn-gelpen-5pk",
    name: "Gel Pen Pack (5 pens)",
    price: 15000,
    category: "stationery",
    stock: 95,
    tags: ["pen", "stationery", "gel", "blue", "pack"],
    description: "Pack of five 0.7mm blue gel pens with quick-drying, smudge-resistant ink.",
  },
  {
    id: "chg-powerbank-10k",
    name: "10000mAh Power Bank",
    price: 129900,
    category: "chargers",
    stock: 12,
    tags: ["power-bank", "charger", "portable", "usb-c", "10000mah"],
    description: "10000mAh power bank with 22.5W USB-C output and simultaneous pass-through charging.",
  },
  {
    id: "acc-laptop-stand",
    name: "Aluminium Laptop Stand",
    price: 109900,
    category: "accessories",
    stock: 9,
    tags: ["stand", "laptop", "ergonomic", "aluminium", "desk"],
    description: "Foldable aluminium laptop riser with six height settings and a ventilated base.",
  },
  {
    id: "cbl-hdmi-usbc",
    name: "USB-C to HDMI Adapter",
    price: 69900,
    category: "cables",
    stock: 22,
    tags: ["adapter", "hdmi", "usb-c", "display", "projector"],
    description: "USB-C to HDMI adapter supporting 4K at 30Hz. Useful for campus projectors.",
  },
];

// Validate the seed data at import time. A typo in a price or a missing field
// fails here, at startup, rather than halfway through a live demo.
export const catalogSchema = z.array(productSchema).min(1);
const products = catalogSchema.parse(PRODUCTS);

// The catalog is meant to be read by agents, not just by our own frontend, so
// the payload states its own units. Without this an agent sees "price: 29900"
// with no way to know whether that means rupees or paise — a 100x error waiting
// to happen. Declared here, not in the HTTP layer, so every consumer (Express
// route, MCP tool) reports the same units from the same source.
export const CURRENCY = "INR";
export const UNIT = "paise";

/** The whole catalog, as a self-describing payload. */
export function getCatalog() {
  return { currency: CURRENCY, unit: UNIT, products };
}

/** One product by id, or null if no such product exists. */
export function getProduct(id) {
  return products.find((product) => product.id === id) ?? null;
}
