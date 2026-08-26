# ETHLabs Interview Cheat Sheet — English

## How to use this

🟢 **CORE** → main idea to mention.
🔵 **TRIGGER** → words that tell you which section to look at.
🟡 **NUANCE** → useful detail if Barnabé goes deeper.
🔴 **DON’T CLAIM** → boundary you should never cross.
🟣 **IF PUSHED** → deeper follow-up material.

---

# 🟢 1. TELL ME ABOUT YOURSELF

🔵 **TRIGGER:** tell me about yourself / background / walk me through your CV / who are you

I’m a software engineer from Bolivia, and most of my experience has been around payments and financial infrastructure.

Professionally, I work on payment, remittance, and digital-asset systems.

Outside of work, I’m building Parmelia, an experimental self-custodial stablecoin payment product.

Through Parmelia, I’ve worked with smart accounts, ERC-4337, passkeys, gas sponsorship, payment intents, indexing, reconciliation, and webhooks.

That work made me increasingly interested in the boundary between applications and the protocol — how inclusion, confirmation, finality, account abstraction, and interoperability become actual product decisions.

That interest led me to write *Settlement Without Surrender*, and it’s one of the main reasons I’m interested in Ethlabs.

---

# 🟢 2. WHY ETHLABS?

🔵 **TRIGGER:** Why Ethlabs? / why us? / what interested you? / why now?

What stood out to me was the way Ethlabs positions itself between real Ethereum usage and protocol development.

My background is mostly on the application side — payments, stablecoins, and account abstraction.

But building those systems made me curious about what needs to improve underneath them so products can become faster and easier to use without giving up self-custody, openness, or censorship resistance.

I think I can bring a practical application perspective while growing into engineering work that is closer to the protocol.

The timing is also especially interesting because areas like FCR, FOCIL, Quick Slots, and native account abstraction are moving from research toward implementation, coordination, and adoption.

---

# 🟢 3. WHAT KIND OF ROLE ARE YOU LOOKING FOR?

🔵 **TRIGGER:** what are you looking for / what role / what do you want to work on

I’m mainly looking for a software engineering or applied R&D role.

I’d be interested in building prototypes, tools, and integrations around:

* settlement;
* FCR adoption;
* account abstraction;
* wallets;
* payments;
* interoperability.

I wouldn’t present myself as a formal consensus researcher.

My immediate contribution would be turning protocol guarantees and proposals into infrastructure that real applications can test and use.

---

# 🟢 4. WHAT CAN YOU CONTRIBUTE?

🔵 **TRIGGER:** why you / what could you contribute / what makes you different / strongest skill

I think I can bring together a few things that don’t always come in the same profile:

* practical financial-infrastructure experience;
* Ethereum application development;
* account abstraction;
* payment systems;
* attention to trust boundaries;
* technical communication.

I’m used to thinking beyond the smart contract itself:

* authorization;
* backend services;
* indexing;
* reconciliation;
* idempotency;
* webhooks;
* retries;
* partial failures.

My strongest skill is connecting those layers and asking what authority each component has, what happens when it fails, and what evidence the application needs before acting.

---

# 🟢 5. PARMELIA

🔵 **TRIGGER:** Parmelia / what are you building / personal project

Parmelia is an experimental self-custodial stablecoin payment system.

The idea is to bring the experience closer to a conventional payment application:

* use a passkey instead of a seed phrase;
* sponsor gas;
* hide some blockchain complexity;
* keep payment authorization under the user’s control.

It includes:

* ERC-4337 smart accounts;
* WebAuthn/passkeys;
* paymasters;
* payment links;
* payment intents;
* indexing;
* reconciliation;
* webhooks;
* testnet CCTP cross-chain components.

It is currently a testnet product.

The main active network is **Arbitrum Sepolia**.

🔴 **DON’T CLAIM**

* No mainnet deployment.
* Not audited.
* Not ready for production funds.
* Not “trustless.”

---

# 🟢 6. WHY IS IT SELF-CUSTODIAL?

🔵 **TRIGGER:** self-custody / backend / can backend move funds / trust assumptions

A normal payment requires a valid signature from the user’s passkey.

The backend does not hold that private key.

It can prepare, sponsor, and relay an operation, but it cannot independently create the normal authorization accepted by the smart account.

But self-custodial does not mean trust-free.

There are still dependencies such as:

* RPC providers;
* bundlers;
* paymasters;
* the recovery guardian;
* upgrade authorities;
* Firebase for identity;
* Circle for USDC and CCTP.

Some mainly affect availability.

Others can affect security or control.

I think making that distinction explicit is important.

---

# 🟢 7. ERC-4337

🔵 **TRIGGER:** ERC-4337 / UserOperation / EntryPoint / bundler / paymaster

I chose ERC-4337 because it enables programmable accounts without requiring an immediate protocol change.

**UserOperation:** describes what the smart account wants to execute.

**Bundler:** collects UserOperations and submits them through EntryPoint.

**EntryPoint:** coordinates validation, execution, and gas accounting.

**Paymaster:** can sponsor gas.

Benefits:

* passkeys;
* gas sponsorship;
* batching;
* recovery;
* programmable accounts.

Trade-off:

it introduces another infrastructure layer and new availability dependencies.

A bundler can censor or go down.

A paymaster can run out of funds.

But neither should be able to create valid user authorization by itself.

---

# 🟢 8. PASSKEYS

🔵 **TRIGGER:** passkeys / WebAuthn / P256 / seed phrase

Passkeys let users rely on security mechanisms already built into their devices, such as biometrics or a device PIN, instead of managing a seed phrase.

Technically, they use WebAuthn and P256 signatures.

For payments, I find them especially interesting because they improve UX without necessarily giving custody to the application.

But they don’t solve everything:

* recovery;
* device compatibility;
* synchronization;
* platform dependencies.

---

# 🟢 9. WHY ARBITRUM?

🔵 **TRIGGER:** Arbitrum / why that network / L2 choice

I chose Arbitrum mainly for practical reasons:

* low costs;
* mature EVM infrastructure;
* RIP-7212;
* efficient P256 verification;
* good ERC-4337 infrastructure;
* gas sponsorship.

P256 matters especially because Parmelia uses WebAuthn passkeys.

I didn’t want the product to be permanently tied to one network, so the configuration was designed to be portable.

The current deployment is on **Arbitrum Sepolia**, not Arbitrum One.

🟡 **TRADE-OFF**

Arbitrum still introduces L2-specific dependencies:

* the sequencer;
* the bridge;
* the settlement relationship with Ethereum.

I chose it because those trade-offs made sense for the product and for testing the UX, not because I think an L2 removes every trust or interoperability problem.

---

# 🟢 10. RECONCILIATION

🔵 **TRIGGER:** reconciliation / payment status / receipt / event / idempotency

One of the biggest things I learned from building payments is:

**a transaction does not automatically equal a completed payment.**

The reconciliation system watches onchain events and connects them to the relevant payment intent.

It needs to:

* be idempotent;
* tolerate retries;
* reconstruct the correct state even if the browser disappears;
* handle partial failures.

With ERC-4337, the outer `handleOps` receipt is also not enough.

An individual UserOperation may have a different result.

So you need to verify the corresponding `UserOperationEvent`.

---

# 🟢 11. SETTLEMENT WITHOUT SURRENDER

🔵 **TRIGGER:** article / settlement / Application Settlement Policy

The main thesis is:

Ethereum can expose protocol guarantees, but an application still needs to decide what to do with them.

Knowing that a transaction is `safe` or `finalized` does not automatically tell:

* a merchant to release a product;
* an exchange to credit a deposit;
* a bridge to advance liquidity.

I call the application layer that makes that translation an **Application Settlement Policy**.

The model is:

**signal → guarantee → context → decision**

Transaction states:

`observed → included → safe → finalized`

Possible actions:

`pending → reserve → provisional credit → irreversible settlement`

🔴 **IT IS NOT**

* an EIP;
* a new consensus mechanism;
* a new definition of finality.

---

# 🟢 12. WHY ISN’T `safe` ENOUGH?

🔵 **TRIGGER:** safe / stale safe / why another layer?

Because `safe` is a protocol signal, not a business decision.

The application still needs to know:

* does `safe` cover the payment block?
* what mechanism produced it?
* is it still advancing?
* which provider reported it?
* does the product’s risk model allow action?

Also:

an RPC call can succeed while still returning an old `safe` head.

So:

**RPC success does not necessarily mean the settlement guarantee is fresh.**

---

# 🟢 13. FCR

🔵 **TRIGGER:** FCR / fast confirmation / confirmation rule

FCR is a fast confirmation rule run locally by consensus clients.

It can provide a strong confirmation signal much earlier than finality under explicit assumptions.

The main assumptions are:

* network synchrony;
* less than roughly 25% adversarial stake.

It does not provide the same economic security backed by slashing as finality.

So:

**FCR complements finality. It does not replace it.**

If conditions deteriorate, FCR may stop advancing.

The application should detect that stall and wait for a stronger guarantee.

🔴 **NEVER SAY**

“FCR is fast finality.”

---

# 🟢 14. FCR VS FINALITY

🔵 **TRIGGER:** difference / security / why not finality?

Finality is Ethereum’s strongest normal economic guarantee and is backed by slashable stake.

FCR is optimized for speed and provides a deterministic guarantee under explicit assumptions.

An application may use FCR for:

* reversible actions;
* limited exposure;
* reducing locked capital;

while still waiting for finality before doing something irreversible.

---

# 🟢 15. QUICK SLOTS

🔵 **TRIGGER:** EIP-8198 / Quick Slots / 10 seconds / 8 seconds

For me, the important value is not simply going from twelve to ten seconds.

The important architectural change is making slot duration **parametric**.

That creates a path for iterative latency reductions based on real evidence.

Benefits:

* faster inclusion;
* faster FCR;
* faster wall-clock finality;
* fresher onchain prices;
* better UX;
* better interoperability.

Trade-offs:

* less time for propagation;
* less time for validation;
* more pressure on hardware and networking;
* potential decentralization impact.

🟡 **10 vs 8**

Ethlabs is advocating an initial 12 → 10 reduction for Hegotá.

The broader draft has used 8 seconds as a provisional value.

I would not present either as a final decision.

---

# 🟢 16. FOCIL

🔵 **TRIGGER:** FOCIL / censorship resistance / inclusion

FOCIL is designed to strengthen transaction inclusion and censorship resistance.

From a payments perspective, the key idea is:

**a transaction that cannot get into a block cannot be confirmed or settled.**

So inclusion is part of settlement.

Difference:

**FOCIL → inclusion**

**FCR → confirmation**

FOCIL does not mean every transaction is guaranteed immediate inclusion or a specific ordering.

---

# 🟢 17. ACCOUNT ABSTRACTION

🔵 **TRIGGER:** AA / account abstraction / payments

For me, account abstraction is not just wallet UX.

In payments, it becomes part of the payment rail.

If someone needs:

* a seed phrase;
* ETH for gas;
* knowledge of networks;
* knowledge of blockchain infrastructure;

just to send USDC, the experience is not competitive with a conventional payment application.

AA can improve that UX without automatically giving custody to a company.

But the surrounding dependencies still matter:

* bundlers;
* paymasters;
* RPCs;
* recovery guardians;
* simulation services.

A smart account can be self-custodial at the authorization layer while still having a fragile or censorable transaction path.

---

# 🟢 18. FRAME TRANSACTIONS

🔵 **TRIGGER:** Frames / EIP-8141 / native AA

Frames is a proposal for more native account abstraction.

It enables programmable validation and execution in a native transaction type instead of relying entirely on the parallel UserOperation + EntryPoint path.

It could improve:

* batching;
* flexible validation;
* new signature schemes;
* privacy;
* future post-quantum authorization.

But it does not magically solve:

* wallets;
* recovery;
* sponsorship;
* L2 coordination;
* RPC support;
* tooling.

The challenge is not only shipping the primitive.

It is also achieving coherent adoption across the ecosystem.

---

# 🟢 19. INTEROPERABILITY

🔵 **TRIGGER:** interop / cross-chain / intents / solver / bridge

For a user, the goal is not:

“bridge from one execution environment to another.”

The goal is:

“I want this person to receive 100 USDC.”

Intents can help because the user declares the desired outcome and solvers compete to fulfill it.

But hiding complexity should not mean transferring control.

My principle is:

**Abstraction should compress complexity, not transfer sovereignty.**

Solvers, bridges, and relayers can exist.

But ideally they should be:

* replaceable;
* auditable;
* competitive;
* bypassable when necessary.

Cross-chain settlement is a sequence of guarantees, not one green checkmark.

---

# 🟢 20. CROPS

🔵 **TRIGGER:** CROPS / censorship / privacy / openness / security

I treat CROPS as engineering criteria.

For a payment product, I would ask:

* Can one provider stop the user from operating?
* Are the critical rules auditable?
* Can the provider be replaced?
* What user information is exposed?
* Who can change the account?
* Is there an exit path?

A managed server is not automatically bad.

The important question is:

**Is it a replaceable convenience or an unavoidable authority?**

---

# 🟢 21. BANK / PROFESSIONAL EXPERIENCE

🔵 **TRIGGER:** current job / bank / real money / regulated environment

I work on initiatives related to payments, remittances, and digital assets.

One of the biggest lessons is that moving money is not only about executing the main operation.

You also need:

* authorization;
* reconciliation;
* traceability;
* idempotency;
* duplicate handling;
* partial-failure handling;
* operational evidence.

That discipline strongly influenced the way I think about settlement.

🔴 **DON’T SHARE**

* internal architecture;
* credentials;
* customer information;
* transaction amounts;
* confidential implementation details.

---

# 🟢 22. WHY STABLECOINS?

🔵 **TRIGGER:** stablecoins / USDC / why payments

Stablecoins provide a much more useful unit of account for payments and remittances.

They do not remove risk.

They still depend on the issuer, reserves, and policy.

My interest is combining that practical utility with Ethereum’s open and self-custodial properties.

I don’t see stablecoins and ETH as direct competitors.

Stablecoins can generate activity and settlement demand.

ETH remains the native economic asset securing the network.

---

# 🟢 23. AVALANCHE RESEARCH

🔵 **TRIGGER:** research / Avalanche / protocol / economics

My Avalanche work is a research proposal around Avalanche L1 validator fees.

It looks at:

* validator participation;
* P-Chain costs;
* developer entry barriers;
* validator concentration;
* AVAX value capture.

It proposes empirical analysis and agent-based simulations.

I would not present it as completed research.

The important part for Ethlabs is that it gave me experience thinking about:

* incentives;
* decentralization;
* security;
* protocol economics;

beyond application code.

---

# 🟢 24. WHAT WOULD YOU BUILD AT ETHLABS?

🔵 **TRIGGER:** if you started tomorrow / what would you build / first project

I would first talk to the team and potential adopters.

I don’t want to build something only because I personally find it interesting.

My initial idea would be an application-facing FCR adoption tool:

* observe `latest`, `safe`, and `finalized`;
* measure freshness;
* detect stalls;
* verify transaction coverage;
* record provenance;
* apply versioned policies;
* simulate failures.

Then I would integrate it with:

* a bridge;
* an exchange;
* a checkout;
* or a deposit flow.

And measure whether it actually reduces latency or locked capital without increasing incorrect decisions.

---

# 🟢 25. PROTOCOL OR APPLICATION?

🔵 **TRIGGER:** where should this live / app or protocol / standard

I would ask:

**Which guarantee is missing, and who is capable of providing it?**

If many applications need the same property and cannot obtain it without trusting an intermediary:

→ there may be a protocol or standards problem.

If Ethereum already exposes enough information and the difference comes from each product’s risk model:

→ it probably belongs at the application layer.

If the technology already exists but the relevant actors are not aligned:

→ it may mainly be a coordination problem.

---

# 🟡 26. YOUR WEAKNESS

🔵 **TRIGGER:** weakness / consensus experience / client experience / seniority

My formal experience with consensus and client implementation is still smaller than my experience building applications.

I don’t try to hide that.

My immediate contribution would be in:

* engineering;
* prototypes;
* integrations;
* application-facing infrastructure.

While gradually building deeper client and protocol knowledge.

When I don’t know something well enough, I prefer to say so and verify it rather than improvise.

---

# 🟡 27. IF HE CHALLENGES YOUR ARTICLE

🔵 **TRIGGER:** obvious / not research / no prototype / why useful

I don’t present it as formal research or a peer-reviewed paper.

It is applied technical writing.

I also don’t claim that nobody has used confirmation policies before.

My hypothesis is that making these things explicit:

* guarantee;
* freshness;
* provenance;
* context;
* policy version;
* decision;

can improve integrations and auditability.

The right way to prove that is to build it and measure whether it helps.

If it doesn’t help, I would change the idea or stop the work.

---

# 🟣 28. BEHAVIORAL QUESTIONS

## TECHNICAL MISTAKE

I learned that a successful outer `handleOps` receipt does not necessarily mean an individual UserOperation succeeded.

I changed the reconciliation path to verify the correct event and made the processing idempotent.

**Lesson:** the evidence has to match the exact economic operation you claim to have confirmed.

## DISAGREEMENT

I try to separate the goal from the proposed solution.

First, I understand which risk the other person is trying to solve.

Then I make the trade-offs explicit and, when possible, suggest a small test.

I’d rather change my mind based on evidence.

## AMBIGUITY

I first define the decision we need to make.

Then I define what evidence would be enough.

Then I reduce the problem to a small prototype or experiment.

## FEEDBACK

I try to turn feedback into something testable.

If it reveals a real error, I correct it.

If it is a trade-off, I make that trade-off explicit.

---

# 🟡 29. IF HE ASKS ABOUT YOUR ENGLISH

My current English level is around B2.

I can work comfortably with technical documentation and have technical conversations.

Sometimes I may need someone to repeat part of a question or give me a few seconds to organize an answer.

I’d rather do that and answer accurately than improvise.

---

# 🟢 30. QUESTIONS FOR BARNABÉ

## Technical

> As FCR moves toward adoption, where do you see the biggest problem today: protocol work, application integration, or coordination with adopters?

## Fit

> For someone with my background in payments and ERC-4337, what would be the most useful problem to start working on?

## Team

> How do application-focused engineers and protocol researchers work together day to day at Ethlabs?

## Process

> What would the next step look like, and what would you want to evaluate in more depth?

Use only one or two.

---

# 🟡 31. WHEN YOU DON’T KNOW

> I haven’t gone deep enough into that part to give you a confident answer.

> My current understanding is X, but I would need to verify Y.

> I’ve mainly looked at that from the application side, so I don’t want to overstate what I know about the client implementation.

> Let me think about that for a second.

> If I understood correctly, you’re asking about…

> Could you repeat the last part, please?

> Could you rephrase the question?

🔴 **NEVER BLUFF**

---

# 🔴 32. FACTS YOU MUST NEVER CONTRADICT

* I’m a software engineer, not a formal consensus researcher.
* Parmelia is on testnet.
* Arbitrum Sepolia, not Arbitrum One.
* Parmelia is not audited.
* Self-custodial does not mean trust-free.
* FCR is not finality.
* `safe` is not a business decision.
* `safe` can become stale.
* FOCIL = inclusion.
* FCR = confirmation.
* Quick Slots is not yet confirmed.
* Settlement Policy is not an EIP.
* Recorr v2 is not publicly deployed.
* Avalanche research is ongoing/proposed work, not completed results.

---

# ⭐ 33. IF YOU GET LOST, RETURN HERE

**WHO I AM**
Software engineer + payments + financial infrastructure.

**WHAT I BUILT**
Parmelia: passkeys + ERC-4337 + sponsorship + reconciliation.

**WHAT I LEARNED**
Transaction ≠ completed payment.

**WHY ETHLABS**
Real application needs ↔ protocol work.

**WHAT I WANT**
Engineering / applied R&D.

**ARTICLE**
Signal → guarantee → freshness → context → decision.

**FCR**
Fast confirmation under explicit assumptions. NOT finality.

**AA**
Better UX without giving up custody.

**CROPS**
Convenience is fine. Mandatory gatekeepers are not.

**WHEN I DON’T KNOW**
Say it. Explain what you do know. Verify the rest.
