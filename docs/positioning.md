# Where Setu fits

*Spike for [#12](https://github.com/samprith02/SETU/issues/12). Researched October 2026.
Every protocol below is still moving, so recheck the sources before relying on a detail.*

## The short version

Setu is **not a payment rail** and should not try to become one. UPI Reserve Pay, Google's
AP2 and OpenAI/Stripe's ACP already cover how an agent gets authority to pay and how money
moves. Razorpay and NPCI have already shipped agentic payments on Claude and ChatGPT.

What none of them does is give the **merchant** a deterministic, auditable decision before it
charges an agent-originated order, plus evidence it can show afterwards. NPCI's chairman drew
exactly this line at GFF 2026:

> "Decision making and execution must remain separate."
> "AI may recommend, but authentication and final settlement must follow deterministic auditable rules."
> — Ajay Kumar Choudhary, NPCI, Global Fintech Fest, 10 Sep 2026 ([MediaNama](https://www.medianama.com/2026/09/223-npci-ai-agents-upi-payments/))

**Setu is that rule layer on the merchant's side:** it verifies the customer's mandate, gates
the order, holds budget, records why, and produces evidence. It does this regardless of which
rail settles the payment.

## The landscape

| | What it is | Who enforces limits | Status (Oct 2026) |
|---|---|---|---|
| **UPI Reserve Pay** | The customer blocks an amount in their bank account against one merchant; the merchant then debits it repeatedly without a fresh PIN. Formerly "Single Block Multiple Debits". | The issuer bank enforces the block total. Nothing enforces *what* each debit is for. | Live. Reported limits: up to ₹10,000 for up to 90 days, one block per merchant per customer.¹ Razorpay offers it through early access only; no public API docs. |
| **Razorpay × NPCI agentic payments** | Agent checkout inside ChatGPT (pilot, Oct 2025) and Claude (Feb 2026, with Zomato, Swiggy, Zepto), built on Reserve Pay and UPI Circle. | Bank (block), plus the merchant's own systems. | Pilot with large merchants. |
| **NPCI Unified Agent Protocol (UAP)** | Reported framework for agents to pay on UPI without per-transaction approval, building on UPI Circle and Reserve Pay, with "spending limits, identity checks and audit trails". | Unclear. | **Not published.** It was widely reported as coming to GFF 2026, but only a keynote described the principles. NPCI has not released a spec, and liability rules are still unannounced. |
| **Google AP2** | Signed mandates as SD-JWT verifiable credentials. *Open* mandates (user → agent: constraints for future purchases) and *closed* mandates (one specific checkout or payment). | Whoever verifies the mandate. AP2 defines the format, not the verifier's bookkeeping. | Open spec and SDK; last repo commit 29 Apr 2026. |
| **OpenAI / Stripe ACP** | Checkout API plus the Delegated Payment Spec: a card token restricted by an `allowance` (`reason: one_time`, `max_amount`, `currency`, `merchant_id`, `checkout_session_id`, `expires_at`). | The PSP vault enforces the token's allowance. | Live. Direct integration is for PSPs and PCI DSS level 1 merchants; everyone else goes through Stripe. Card-only. |

¹ From a secondary summary of NPCI circular OC-228/2025-26 (8 Oct 2025). The primary text was not checked.

## What every rail leaves to someone else

- **The rule beyond the amount.** A Reserve Pay block caps the total. An ACP allowance caps one charge. Neither knows that the customer said "stationery only", or "nothing over ₹500 each". AP2 can *state* such constraints, but enforcing them is left to whoever verifies.
- **Budget state.** AP2's `payment.budget` with `payment.agent_recurrence` means someone has to track spend across purchases. That is exactly Setu's ledger, `spentUnder` and holds (#3, #4).
- **Why it happened.** No rail records the agent's stated intent, which rule applied, or what was refused and offered instead. That is the audit trail, and it is what the NPCI keynote asks for.
- **Proof for the merchant.** When a customer disputes an agent purchase, the merchant needs to show it was authorized. That is the evidence pack (#7).

## Mapping Setu's mandate onto the standards

| Setu today (`mandate.js`) | AP2 Open Payment Mandate | ACP allowance | Reserve Pay |
|---|---|---|---|
| `per_txn_cap` (int paise) | `payment.amount_range.max` (int, minor units) | `max_amount` (int, one-time) | — |
| `max_amount` (int paise) | `payment.budget.max` (**float**) + `payment.agent_recurrence` | — | block amount |
| `category_allowlist` | **no equivalent** (closest: `checkout.line_items`, SKU-level) | — | — |
| `expiry` (ISO) | `exp` (Unix epoch); `payment.execution_date.not_after` | `expires_at` (RFC 3339) | block validity |
| *(none)* merchant scope | `payment.allowed_payees` / `checkout.allowed_merchants` | `merchant_id` | the merchant the block is against |
| `spent`, `held` | not in the mandate; verifier state | — | bank-side |
| *(none)* customer signature | SD-JWT, key-bound via `cnf` (RFC 7800) | PSP token | UPI PIN at block time |

## Decisions this forces

1. **Don't invent a mandate format.** #6 should accept an **AP2 Open Payment Mandate** as its input format, rather than a home-grown signed JSON. AP2 already has the signature model (SD-JWT with key binding), constraint types for most of Setu's rules, and adoption. Setu's own `mandate.js` rules become the *verifier* for it.
2. **Category stays, as a Setu extension constraint.** AP2 has no category rule, and category is Setu's most distinctive check. Add it as a namespaced constraint type (e.g. `setu.category_allowlist`) that Setu's verifier enforces and other verifiers can ignore.
3. **Money stays integer paise inside Setu.** AP2's `payment.budget.max` is a float. Convert once at the boundary, and **reject** any value that isn't a whole number of paise rather than rounding. Same invariant as `CLAUDE.md`.
4. **Add merchant scope to Setu's mandate.** Every standard binds authority to a payee, and Setu's mandate doesn't. A mandate for the tech store must not approve a purchase at the study store.
5. **On Reserve Pay, Setu runs before the merchant debits.** The bank guarantees the block. Setu decides whether *this* debit is within the customer's rules, and records it. Same gate, different settlement call.
6. **ACP's one-time allowance is what a step-up approval produces (#8).** One-time grant, exact amount, short expiry, bound to one checkout. Build #8 in that shape.

## What Setu will not do

- Hold or move money, or vault cards. That's for the rails and PSPs.
- Compete with Razorpay's own agentic checkout. Setu works for merchants on Razorpay; it isn't an alternative to it.
- Wait for UAP. Build against AP2 and Reserve Pay, and adapt if UAP publishes a format.

## Open questions

- **UAP's actual format and liability model.** Unpublished. Recheck NPCI's site and GFF follow-ups.
- **Reserve Pay API access** for a small merchant through Razorpay. It's early access only, and the debit API isn't publicly documented.
- **Whether AP2 Open Mandates are used in India at all.** The Razorpay/NPCI pilots are UPI-native, and it's not known whether they carry AP2 credentials.

## Follow-up work

- [#6](https://github.com/samprith02/SETU/issues/6) updated with decisions 1–3.
- [#15](https://github.com/samprith02/SETU/issues/15): merchant scope on the mandate (decision 4).
- [#16](https://github.com/samprith02/SETU/issues/16): Reserve Pay pre-debit gate (decision 5).
- [#8](https://github.com/samprith02/SETU/issues/8) updated with decision 6.

## Sources

- NPCI keynote, GFF 2026: [MediaNama](https://www.medianama.com/2026/09/223-npci-ai-agents-upi-payments/)
- UAP reporting: [Startup Fortune (Reuters)](https://startupfortune.com/indias-npci-is-building-a-protocol-to-let-ai-agents-pay-on-upi/), [Inc42](https://inc42.com/buzz/npci-to-launch-agentic-payments-on-upi-report/)
- Reserve Pay: [Razorpay](https://razorpay.com/blog/upi-reserve-pay/), [Complinity summary of the NPCI circular](https://complinity.com/legal-update/npci-issues-enhancements-in-upi-single-block-multiple-debits-upi-reserve-pay--20722/), [PayU docs](https://docs.payu.in/docs/upi-reserve-pay), [Pine Labs docs](https://www.pinelabs.com/docs/online-payments/upi-reserve-pay)
- Razorpay agentic payments: [on Claude](https://razorpay.com/newsroom/razorpay-npci-launch-agentic-payments-on-claude-powering-zomato-swiggy-zepto-at-the-india-ai-impact-summit/), [on ChatGPT (Business Standard)](https://www.business-standard.com/companies/news/razorpay-npci-and-openai-launch-agentic-payments-on-chatgpt-125100900601_1.html)
- AP2: [google-agentic-commerce/AP2](https://github.com/google-agentic-commerce/AP2), `code/sdk/python/ap2/sdk/generated/{open_payment_mandate,open_checkout_mandate,payment_mandate,checkout_mandate}.py`
- ACP: [OpenAI Delegated Payment Spec](https://developers.openai.com/commerce/specs/payment)
