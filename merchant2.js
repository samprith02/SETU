// Setu — second merchant catalog: Campus Study & Office Essentials
//
// A fictional bookstore and stationery shop that demonstrates the portability
// of the mandate+audit contract. The rules in mandate.js, payments.js and
// audit.js are IDENTICAL to those the campus tech store uses — this file is
// the only thing that differs between the two merchants.
//
// Why this matters: Setu's pitch is that it is a portable trust primitive, not
// a one-merchant integration. Two merchants sharing the same contract surface
// is the cheapest possible demonstration of that claim: same tool names, same
// mandate schema, different catalog seed.
//
// MONEY: integer paise throughout, matching catalog.js.

import { z } from "zod";
import { productSchema, catalogSchema, CURRENCY, UNIT } from "./catalog.js";

// The study-store catalog. Price spread mirrors the tech store:
//   ₹500 per-txn cap blocks the premium items (mechanical keyboard, drawing
//   tablet) and admits the everyday essentials.
const STUDY_PRODUCTS = [
  {
    id: "bk-notebook-hardcover",
    name: "Hardcover A5 Notebook (240 pages)",
    price: 29900,
    category: "stationery",
    stock: 80,
    tags: ["notebook", "stationery", "hardcover", "a5", "paper", "ruled"],
    description:
      "240-page A5 hardcover notebook with ivory-toned pages, ribbon bookmark and elastic closure.",
  },
  {
    id: "bk-pen-set-fineliner",
    name: "Fineliner Pen Set (10 colours)",
    price: 34900,
    category: "stationery",
    stock: 60,
    tags: ["pen", "fineliner", "stationery", "colour", "art", "drawing"],
    description: "10 water-based fineliner pens in assorted colours, 0.4mm tip, fade-resistant ink.",
  },
  {
    id: "bk-highlighter-6pk",
    name: "Highlighter Pack (6 colours)",
    price: 18900,
    category: "stationery",
    stock: 110,
    tags: ["highlighter", "stationery", "colour", "study", "marker"],
    description: "6 chisel-tip highlighters in yellow, orange, pink, green, blue and purple.",
  },
  {
    id: "bk-sticky-notes-xl",
    name: "XL Sticky Notes (3-pack)",
    price: 22900,
    category: "stationery",
    stock: 95,
    tags: ["sticky-notes", "stationery", "study", "notes", "paper"],
    description: "3 pads of 100-sheet XL sticky notes (127×76mm) in yellow, blue and pink.",
  },
  {
    id: "bk-desk-organiser",
    name: "Bamboo Desk Organiser",
    price: 79900,
    category: "desk",
    stock: 25,
    tags: ["organiser", "desk", "bamboo", "storage", "stationery"],
    description:
      "5-slot bamboo desk organiser for pens, scissors, rulers and small accessories.",
  },
  {
    id: "bk-whiteboard-a3",
    name: "A3 Lap Whiteboard with Markers",
    price: 59900,
    category: "desk",
    stock: 30,
    tags: ["whiteboard", "study", "desk", "marker", "a3", "lap"],
    description:
      "A3 double-sided lap whiteboard with one black and one blue dry-erase marker.",
  },
  {
    id: "bk-flash-cards-200",
    name: "Blank Flash Cards (200-pack)",
    price: 24900,
    category: "stationery",
    stock: 70,
    tags: ["flash-cards", "stationery", "study", "paper", "cards"],
    description:
      "200 unlined A6 index cards with a reinforced ring binder for revision and mind-mapping.",
  },
  {
    id: "bk-drawing-tablet",
    name: "Digital Drawing Tablet (S)",
    price: 229900,
    category: "tech",
    stock: 8,
    tags: ["tablet", "drawing", "digital", "stylus", "usb", "tech"],
    description:
      "Compact digital drawing tablet with 2048 pressure levels, USB-C connectivity and a passive stylus.",
  },
  {
    id: "bk-mechanical-keyboard",
    name: "Compact Mechanical Keyboard (TKL)",
    price: 349900,
    category: "tech",
    stock: 5,
    tags: ["keyboard", "mechanical", "tech", "usb", "tenkeyless", "typing"],
    description:
      "87-key TKL mechanical keyboard with brown switches, USB-C detachable cable and per-key RGB.",
  },
  {
    id: "bk-pomodoro-timer",
    name: "Mechanical Pomodoro Timer",
    price: 44900,
    category: "desk",
    stock: 40,
    tags: ["timer", "pomodoro", "desk", "study", "productivity", "mechanical"],
    description:
      "60-minute mechanical countdown timer with a loud ring. No batteries, no app.",
  },
  {
    id: "bk-book-stand",
    name: "Adjustable Book / Tablet Stand",
    price: 69900,
    category: "desk",
    stock: 18,
    tags: ["stand", "book", "tablet", "desk", "adjustable", "ergonomic"],
    description:
      "Folding aluminium book and tablet stand with 6 height settings, fits up to A4.",
  },
  {
    id: "bk-correction-tape-3pk",
    name: "Correction Tape (3-pack)",
    price: 12900,
    category: "stationery",
    stock: 130,
    tags: ["correction", "tape", "stationery", "study"],
    description: "3 ergonomic correction tape rollers, 5mm × 8m each.",
  },
];

const studyProducts = catalogSchema.parse(STUDY_PRODUCTS);

/** Unique categories present in the study catalog. */
export const STUDY_CATEGORIES = [...new Set(studyProducts.map((p) => p.category))];

/** The study-store catalog, with the same self-describing envelope as catalog.js. */
export function getStudyCatalog() {
  return { currency: CURRENCY, unit: UNIT, merchant: "study", products: studyProducts };
}

/** One product by id, or null. */
export function getStudyProduct(id) {
  return studyProducts.find((p) => p.id === id) ?? null;
}

/**
 * Filter the study catalog. Same contract as catalog.js searchCatalog():
 *   query    — free-text across name, description, tags, id
 *   category — exact match
 *   maxPrice — integer paise upper bound
 */
export function searchStudyCatalog({ query = null, category = null, maxPrice = null } = {}) {
  if (maxPrice !== null && (!Number.isInteger(maxPrice) || maxPrice <= 0)) {
    throw new Error(`maxPrice must be a positive integer in paise, got: ${maxPrice}`);
  }

  const terms =
    query === null ? [] : query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);

  const matches = studyProducts.filter((product) => {
    if (category !== null && product.category !== category) return false;
    if (maxPrice !== null && product.price > maxPrice) return false;
    if (terms.length === 0) return true;

    const haystack = [
      product.name,
      product.description,
      product.id,
      product.category,
      ...product.tags,
    ]
      .join(" ")
      .toLowerCase();

    return terms.every((term) => haystack.includes(term));
  });

  const sorted = [...matches].sort((a, b) => a.price - b.price);
  return { currency: CURRENCY, unit: UNIT, merchant: "study", count: sorted.length, products: sorted };
}
