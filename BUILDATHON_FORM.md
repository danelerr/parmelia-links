# Parmelia — Buildathon Submission Kit

> Todo lo que va en el formulario de la **Arbitrum Open House London Buildathon**,
> listo para copiar/pegar, más los guiones de los dos videos. El texto del
> formulario está en **inglés** (jueces internacionales); las notas para ti están
> en español. Direcciones de contrato ya rellenadas (Arbitrum Sepolia).

---

## 0. Antes de enviar — 2 decisiones y 1 checklist

**Decisión 1 — ¿desplegar también en Arbitrum One?**
Sepolia ya califica según las reglas. Pero One: (a) hace que el **swap funcione de
verdad** (liquidez Uniswap real), (b) convierte "production path" en "en
producción", lo que sube PMF y calidad percibida. Es el mismo deploy CREATE2 (mismas
direcciones). Si tienes ~1 día y ~$30-50, hazlo. Si no, Sepolia con demo de swap honesto.

**Decisión 2 — honestidad del swap.**
En **Sepolia el swap no ejecuta** (sin liquidez). Si te quedas en Sepolia, en la
demo muestra el módulo + cotización pero NO claves un swap completado. Si vas a
One, muéstralo ejecutando.

**Checklist pre-grabación (en la chain que vayas a demostrar):**
- [ ] `shared/networks.ts` con las direcciones desplegadas; worker redeployado.
- [ ] Relayer fondeado: ETH (gas) + USDC (faucet de bienvenida).
- [ ] Smoke test verde (`DEPLOY.md §9`): onboarding passkey → crear link → pagar A→B → recibo.
- [ ] `app.parmelia.me`, `parmelia.me`, GitHub y Arbiscan abren sin error.
- [ ] Contratos verificados (Sourcify hecho; idealmente también Arbiscan).

---

## 0.5 Consideraciones que podrías estar pasando por alto

**① Repo público.** Confírmalo (Settings → visibility). Privado = jueces y filtros
no pueden evaluarlo = descarte casi seguro. Es el error #1 de submissions buenos.

**② Seguridad — ya revisado, estás limpio (úsalo a tu favor).** El criterio #1 es
"smart contract quality con mínimas vulnerabilidades". Revisé tu repo:
- La service account de Firebase (`*-firebase-adminsdk-*.json`) **nunca se commiteó**
  y está en `.gitignore`. Bien. Mantenla así; no la fuerces con `git add -f`.
- `server/wrangler.jsonc` solo tiene config no sensible; los secretos (PRIVATE_KEY,
  RPC_URL) van por `wrangler secret`. Buena higiene.
- No hay `.env`, `.pem` ni claves en el historial.
- El paymaster usa ventanas `[validAfter, validUntil]` firmadas (anti-replay) y el
  account tiene guardian recovery con timelock. **Menciónalo** — es exactamente lo
  que un juez técnico busca. (Ya está en Description y README; refuérzalo en el demo.)

**③ Tu historial de commits respalda la narrativa.** El repo muestra trabajo real
dentro de la ventana: `start migration to arbitrum` (8 jun) → frontend v2 → on-chain
→ notifications → ui/ux (14 jun). Si un juez mira el log, confirma lo que dice
"Progress". No lo toques ni hagas squash; el historial es evidencia.

**④ No nombres a "Monad" en el texto público.** Da las razones técnicas (pagas el
gas que usas y no gas reservado; EntryPoint ERC-4337 canónico y verificado;
EIP-712; fees predecibles) sin nombrar la chain anterior. Suena más profesional y
evita que el foco se vuelva "por qué te fuiste de X" en vez de "por qué Arbitrum es
el lugar correcto". Si un juez pregunta en vivo, ahí lo explicas. El kit ya está
redactado así ("a different L1") — mantenlo.

**⑤ Que Earn/DeFi no esté implementado NO te resta.** Tú dijiste "creo que por eso
no vale nada" — al revés. Lo que construiste (smart accounts con passkeys, paymaster
con gas patrocinado, CREATE2 determinista, módulo de swaps, links/QR, PWA, ledger
con recibos) es sustancial y real. El roadmap (card, QR-banco local, Earn, API de
pagos) **suma** porque muestra visión y PMF — siempre que lo presentes como roadmap,
no como features vivas. El kit ya lo hace. No prometas lo que no puedes demostrar.

**⑥ Verificación en Arbiscan, no solo Sourcify.** Para "smart contract quality",
que un juez entre a Arbiscan y vea "Contract Source Code Verified" con un click vale
mucho. Si solo tienes Sourcify, sube también a Arbiscan antes de enviar.

**⑦ Consistencia total.** Mismos contratos, misma chain, mismas features en:
Description, Progress, README, los 2 videos y sus subtítulos. Una sola contradicción
(p. ej. "swap en vivo" en el video pero "no en Sepolia" en el texto) la detectan
jueces y filtros. La honestidad consistente es tu mejor defensa.

---

## 1. Name

```
Parmelia
```

## 2. Intro

Versión completa (si el campo acepta ~300 caracteres):
```
Parmelia is a non-custodial stablecoin payments app on Arbitrum. It lets anyone receive, request, and swap USDC through simple payment links, QR codes, usernames, and a mobile PWA — secured by passkeys and ERC-4337 smart accounts, with no seed phrases and no gas for the user.
```

Versión corta (si "Intro" es un one-liner / ~120 caracteres):
```
Non-custodial stablecoin payments on Arbitrum — pay by link, QR, or username, with passkeys and no gas for the user.
```

## 3. Product Category / Tracks (elige 3)

```
DeFi   ·   Infra   ·   SocialFi
```
- **DeFi** (principal): pagos stablecoin + swaps Uniswap.
- **Infra**: rieles/infraestructura de cobros (ver `API_DESIGN.md`) — encaja con el tema "infrastructure trusted by institutions".
- **SocialFi**: usernames, contactos, invitaciones, links de cobro = capa social de pagos.
- *Alternativa:* cambiar SocialFi por **RWA** si quieres apostar al ángulo institucional (stablecoins = el RWA más adoptado). Solo si te sientes cómodo defendiéndolo.

## 4. Description (pegar tal cual)

```
Parmelia is a stablecoin payments app for people who don't want to think about blockchain. They just want to get paid.

It's built around how people already move money: a link, a QR code, a username, a contact. You share a link, someone pays you in USDC, and you both get a receipt. That's the core idea.

Doing that with crypto today is painful. To receive money you're expected to handle wallet addresses, seed phrases, gas, networks, and transaction hashes, and most people quit before they even start. That hurts most in Latin America and other dollarized economies, where stablecoins are already how a lot of freelancers, families, and small merchants save and get paid in dollars. The technology is useful; the experience isn't.

Parmelia hides all of that, and it never holds your money. Your wallet is a smart account that you control with a passkey, your fingerprint or face. Firebase handles login and the app experience, but it can't touch your funds: every payment needs your passkey. The backend can submit the transaction for you and even cover the gas, but it can't move anything on its own.

What you can do right now:
- Create a wallet with your fingerprint, no seed phrase.
- Get paid through a link or a QR code.
- Pay a username, scan a QR, or paste an address.
- See all your activity (payments, deposits, swaps), each with a receipt showing date, time, and the transaction hash.
- Swap between assets inside the app, with Uniswap routing under the hood.
- Save contacts, invite people, get push notifications, and install it on your phone.

The onchain side is account abstraction (ERC-4337) on Arbitrum: smart accounts authorized by WebAuthn passkeys, deployed at deterministic addresses, with a paymaster that covers gas using short-lived signatures that expire after a few minutes so they can't be reused. The account also supports multiple passkeys, batched calls, upgrades, and guardian recovery with a 48-hour delay.

I chose Arbitrum because a payments app can't make people think about gas. Arbitrum gives me low and predictable fees, you only pay for the gas you actually use, EIP-712 and full Solidity support, a canonical and verified ERC-4337 EntryPoint, and the liquidity I need for swaps. For this buildathon it runs on Arbitrum Sepolia, with everything configured to move to Arbitrum One.

Where this is going (roadmap, not part of this submission): a Parmelia card and local bank-QR settlement so people can spend their stablecoin balance in the real world, an Earn option for idle balances, and a payments API so any app, store, or bot can accept stablecoins the way they accept Stripe today. The payment and account architecture is already built with these in mind.

Links:
- App: https://app.parmelia.me
- Landing: https://parmelia.me
- Main repository: https://github.com/danelerr/parmelia-links
- Landing repository: https://github.com/danelerr/parmelia-landing

Contracts on Arbitrum Sepolia (421614):
- EntryPoint v0.9 (canonical): 0x433709009B8330FDa32311DF1C2AFA402eD8D009
- ERC7913WebAuthnVerifier: 0xb7fA10dEe75042D6973676A7d7882e4621B806d6
- AccountWebAuthnV2 (impl): 0xa450bc49a0dA738FA348445980b542d78A22527e
- AccountFactoryV2: 0x75c7761dcED5F8eCc708E750bDe5CA7d4557EDEB
- ParmeliaPaymaster: 0x31f357a64cF5899da21337f0D9e28ef8D6385753
- Explorer: https://sepolia.arbiscan.io/address/0x75c7761dcED5F8eCc708E750bDe5CA7d4557EDEB
```

> Nota: si despliegas en Arbitrum One, agrega esa sección de direcciones y cambia
> "deployed on Arbitrum Sepolia" por "deployed on Arbitrum One (and Sepolia)".

## 5. Progress During Buildathon (pegar tal cual)

```
Parmelia already existed before the buildathon, but it was a more generic, portable prototype. During Arbitrum Open House London I rebuilt it into something that actually belongs on Arbitrum and that I'd be comfortable putting in front of real users.

The first big decision was the chain. Parmelia used to target a different L1, and I moved it to Arbitrum on purpose. The reasons were practical: on Arbitrum you pay for the gas you actually use, instead of having reserved gas charged to you even when you don't spend it. Fees are low and predictable, EIP-712 works, and the ERC-4337 EntryPoint is canonical and verified, which wasn't the case where I was before. For a payments app, that reliability is the difference between "works" and "don't ship it."

From there, the work fell into three areas.

Contracts. I deployed the V2 smart-account stack to Arbitrum Sepolia (the WebAuthn verifier, the account factory, and the paymaster) and verified it on-chain. I made the deployment deterministic with CREATE2, so the same code produces the same addresses on every chain, and added support for multiple passkeys per account, batched execution, upgradeability, and guardian recovery with a 48-hour timelock. The paymaster sponsors gas with signatures that expire after a few minutes so they can't be replayed. I also had to tune the compiler to keep the account under the 24KB contract-size limit.

Product. I rebranded and rebuilt the whole front end around a mobile-first payments flow (dashboard, send, charge, QR, swap, statement, contacts, receipts) and reworked the transaction history to read from a ledger, with a cron job that picks up deposits coming from outside the app. I added an internal swap module on top of Uniswap routing, turned Parmelia into an installable PWA with push notifications, and split the site into parmelia.me for the landing and app.parmelia.me for the app.

Infrastructure. I cleaned up the Cloudflare Worker backend (D1 database, RPC failover, Turnstile anti-abuse, passkey and email-link login, analytics) and added tests around the parts that handle money: swap encoding, fees and slippage, validation, and the paymaster.

I also designed the next phase on paper (cross-chain deposits, fees, an Earn product, and a Stripe-style payments API), but I'm not presenting those as live features. What's in this submission is what actually works and can be demonstrated: passkey accounts, sponsored gas, payment links and QR, payments, swaps, history, receipts, and the PWA.
```

## 6. Tech Stack (8)

El selector tiene **opciones fijas** (React, Next, Vue, Web3, Ethers, Node, Java,
Go, Python, Solidity, Rust, Move) **+ "Add new"**. No es texto libre. Selecciona así:

**De la lista fija (4):**
```
React · Web3 · Node · Solidity
```
**Con "Add new" (4 más, para llegar a 8):**
```
TypeScript · Foundry · Cloudflare Workers · Firebase
```
- NO marques **Ethers**: usas **viem**, no ethers. "Web3" cubre el genérico onchain.
- Si prefieres precisión sobre amplitud, en "Add new" puedes usar **viem** y
  **ERC-4337 / Account Abstraction** en vez de Cloudflare/Firebase — pero esos dos
  sí son parte real de tu stack y suman keywords útiles. Recomiendo dejarlos.
- No metas "Arbitrum" aquí; ya va como chain/track y en toda la descripción.

## 7. Fundraising Status

```
Bootstrapped. Not currently fundraising, but open to Arbitrum ecosystem grants, milestone-based support, and strategic partnerships.
```

## 8. GitHub Link

```
https://github.com/danelerr/parmelia-links
```
> **Resuelto:** usa el repo principal. Tiene contratos + backend (Worker) + frontend
> — exactamente lo que evalúa el criterio de "smart contract quality". Tu README ya
> enlaza la app en vivo, la landing, el **repo de la landing** y los contratos
> verificados en Arbiscan, así que el segundo repo queda cubierto sin perder nada.
> El input solo acepta un link y este es el correcto.
>
> **CRÍTICO antes de enviar:** confirma que el repo es **público** (Settings →
> visibility). Si está privado, jueces y filtros no pueden verlo = descarte. Y deja
> el README como página de aterrizaje (ya lo está).

## 9. Demo Video / Pitch Video

Son dos uploads. Guiones detallados abajo (§10 y §11).

---

## 10. Demo Video — guion (objetivo: "esto existe y funciona en Arbitrum")

Duración: **2:30–3:00**. Formato: pantalla + voz en off en inglés + subtítulos en
inglés. Cara opcional en burbuja pequeña. Graba esto DESPUÉS del smoke test.

Convención: **[ON SCREEN]** = qué se ve · **[SAY]** = qué narras · **[NOTE]** = tip.

---

**0:00–0:15 — Apertura**
[ON SCREEN] parmelia.me, luego app.parmelia.me.
[SAY] "Hi, I'm Daniel. This is Parmelia: a non-custodial stablecoin payments app deployed on Arbitrum. It uses ERC-4337 smart accounts, WebAuthn passkeys, and sponsored gas to make crypto payments feel like a normal payment app."

**0:15–0:35 — El problema**
[ON SCREEN] landing (secciones), luego el dashboard de la app en vista móvil.
[SAY] "Crypto payments still feel too technical. People shouldn't need to understand addresses, gas, or transaction hashes just to send or receive money. Parmelia hides that — without taking custody of funds."

**0:35–1:05 — Login + cuenta**
[ON SCREEN] login, creación/uso de passkey, dashboard, dirección de la cuenta, balance.
[SAY] "You sign in like a normal app, but payments are authorized with a passkey — your fingerprint. The wallet is a smart account the user controls. Firebase handles identity, not custody. The backend can relay and sponsor gas, but it can't move your funds."
[NOTE] Muestra el prompt biométrico real si puedes; es tu mejor "wow".

**1:05–1:40 — Crear cobro (link + QR)**
[ON SCREEN] "Charge", elegir token, monto, link generado, QR.
[SAY] "Let me request a payment. I pick the asset and amount, and Parmelia generates a payment link and a QR code — no copying addresses, no explaining contracts."

**1:40–2:15 — Pagar (A → B)**
[ON SCREEN] abrir el link como pagador, revisar, confirmar con passkey, estado, recibo/actividad.
[SAY] "From the payer side, you open the link, confirm with your passkey, and Parmelia handles the onchain flow on Arbitrum as a sponsored UserOperation. The payment confirms and shows a receipt — with date, time, and a receipt number that is the transaction hash."
[NOTE] ESTE es el clip más importante. Necesitas 2 cuentas. Que se vea el recibo.

**2:15–2:40 — Swap (módulo)**
[ON SCREEN] pantalla de swap: selector de tokens (USDC/ETH) y monto. Breve, sin quedarte en la cotización.
[SAY] "Parmelia also includes an integrated swap module with Uniswap routing, server-side quoting, and slippage controls — so someone who receives one asset can move to the one they need for a payment."
[NOTE] Estás en Sepolia: el quote puede devolver "sin ruta disponible" (no hay liquidez de testnet). Muestra la UI y los selectores 3-4 segundos y sigue. NO te quedes en una cotización fallida ni claves un swap ejecutado. La ejecución real corre en Arbitrum One.

**2:40–2:55 — Prueba Arbitrum**
[ON SCREEN] Arbiscan con el contrato (factory o paymaster) verificado; el repo en GitHub.
[SAY] "Everything runs on Arbitrum. Here are the deployed, verified contracts on Arbiscan, and the repository with the frontend, the Solidity contracts, and the Cloudflare Worker backend."

**2:55–3:05 — Cierre**
[SAY] "Parmelia makes stablecoin payments feel like sending a message: link, QR, username, fingerprint, done. Next on the roadmap: a Parmelia card and local bank-QR to spend in the real world, Earn on idle balances, and a payments API for any app or store."
[NOTE] La frase de roadmap es opcional. Si el demo ya pasa de 3:00, córtala — el roadmap va completo en el pitch.

---

## 11. Pitch Video — guion (objetivo: por qué importa, por qué Arbitrum, por qué es producto)

Duración: **~2:00–2:15**. Formato: tu cara al inicio y al final + cortes de
pantalla en medio. Voz leída, lento, subtítulos en inglés.

---

**[FACE] 0:00–0:16 — Hook (reconoce la competencia, luego diferencia)**
"Hi, I'm Daniel — I'm building Parmelia. In Latin America, stablecoins are already how freelancers and families save and get paid in dollars. Plenty of apps are trying to make crypto payments easy — but almost all of them do it by holding your money for you, or they still leave you dealing with seed phrases and gas. Parmelia is the one that doesn't."

**[SCREEN] 0:16–0:42 — El diferenciador + producto**
[ON SCREEN] app: link, QR, username, prompt de passkey.
"Parmelia gives you a familiar payment flow — share a link, scan a QR, pay a username, confirm with your fingerprint, get a receipt — but your money never leaves your control. Your wallet is a smart account you own with a passkey. We can relay the transaction and even cover the gas, but we can never move your funds. Easy and self-custodial at the same time — that's the combination most apps give up on."

> Variante más corta y punchy para el [FACE], si prefieres:
> "Hi, I'm Daniel, building Parmelia. Making crypto payments easy isn't new — but
> most apps do it by becoming your custodian. Parmelia makes stablecoin payments
> feel just as simple — link, QR, username, your fingerprint — while your money
> never leaves your control."
>
> NOTA: con esta apertura, el cierre "Parmelia is not another wallet dashboard..."
> sigue funcionando perfecto — refuerza el mismo ángulo (no eres una wallet más,
> eres una experiencia/red de pagos no custodial). No lo cambies.

**[SCREEN] 0:42–1:02 — Cómo funciona (el "cómo" técnico, sin repetir lo de custodia)**
[ON SCREEN] diagrama simple o Arbiscan.
"Technically, that's ERC-4337 account abstraction on Arbitrum. The smart account is authorized by a WebAuthn passkey, Parmelia submits the UserOperation, and a paymaster sponsors the gas with short-lived signatures that expire so they can't be replayed. Standard, auditable account abstraction — used to make a payment feel like a normal app."

> Con la nueva apertura más larga, los timestamps de aquí en adelante corren ~7s:
> Qué hice 1:02–1:27 · Por qué Arbitrum 1:27–1:42 · Roadmap 1:42–2:07 · Cierre
> 2:07–2:22. El pitch queda en ~2:20, sigue siendo corto. Ajústalos al grabar.

**[SCREEN] 0:55–1:20 — Qué hice en el buildathon**
[ON SCREEN] cortes: deploy, swap, rebrand, PWA.
"During Arbitrum Open House London, I committed Parmelia to Arbitrum: deployed and verified the V2 smart-account stack on Arbitrum Sepolia, added deterministic CREATE2 deployment, sponsored gas, an integrated swap module with Uniswap routing, a full product rebrand, a new landing page, and a mobile PWA."

**[SCREEN] 1:20–1:35 — Por qué Arbitrum**
"Arbitrum is the right home: consumer payments need low, predictable fees, mature EVM tooling, account abstraction, and real DeFi liquidity. The same rails institutions trust — with a payment experience normal people can actually use."

**[SCREEN] 1:35–2:00 — Hacia dónde va (roadmap)**
[ON SCREEN] mockups simples o texto de los próximos módulos.
"Payments are the foundation. From here, Parmelia adds a card and local bank-QR settlement so people can spend their stablecoin balance in the real world, an Earn option so idle balances can grow, and a payments API so any store, app, or bot can accept stablecoins the way they accept Stripe today. The payment and account architecture is already built for that."

**[FACE] 2:00–2:15 — Cierre**
"Parmelia is not another wallet dashboard. It's a payment experience — and a payments network — on Arbitrum. Live at parmelia.me, the app at app.parmelia.me. Let's make stablecoin payments feel normal."

---

## 12. Tips de grabación y filtros con IA

- **Graba el demo primero** (te obliga a validar que todo existe), luego el pitch.
- **Subtítulos en inglés correctos** en ambos (los filtros leen el transcript; que coincida con lo que dices).
- **Keywords reales, una vez cada una**, sin stuffing: Arbitrum, ERC-4337, account abstraction, WebAuthn passkeys, paymaster, sponsored gas, USDC, stablecoin payments, Uniswap, smart accounts.
- **Consistencia total** entre Description, Progress, videos y README (mismos contratos, misma chain, mismas features). Las contradicciones penalizan con jueces y filtros.
- **Links que abren**: un link roto es bandera roja fácil.
- **No prometas lo no-demostrable** (swap completo en Sepolia, Earn en vivo). Honestidad consistente gana.
- **Cara**: sí en el pitch (inicio + cierre), opcional en el demo. Tu acento no es problema; para un proyecto LatAm da autenticidad. Habla lento, no improvises.
- **Duración**: corto gana. Los jueces ven decenas de submissions.

### Cómo NO ser descartado por un filtro automático de IA

Tu instinto es correcto: muchas plataformas pre-filtran con un modelo que transcribe
el audio y lo compara con los criterios. Para pasar ese filtro:

1. **Sube subtítulos reales (archivo .srt o los de YouTube revisados a mano), no
   auto-generados sin corregir.** El filtro lee ese texto. Si YouTube transcribe mal
   "Arbitrum" como "arbitration" o "ERC-4337" como "ERC forty-three thirty-seven",
   pierdes la coincidencia con el criterio "deployed on an Arbitrum chain". Revisa
   línea por línea que los términos clave estén bien escritos.
2. **Di las palabras del criterio, literalmente, en voz alta.** El criterio #1 es
   estar en Arbitrum: que tu audio diga "deployed on Arbitrum" y "Arbitrum Sepolia"
   con claridad. Los otros criterios (product-market fit, real problem solving,
   innovation) — toca cada uno en una frase: el problema real (stablecoins en LatAm),
   el encaje (freelancers/familias/comercios), lo innovador (passkeys + gas
   patrocinado = pagos cripto que se sienten normales).
3. **Audio limpio.** Un filtro transcribe mal el audio con ruido/eco. Graba en
   sitio silencioso, micro cerca, sin música tapando la voz. Audio malo = transcript
   malo = el filtro "no encuentra" tus keywords aunque las digas.
4. **Primeros 15 segundos cargados de señal.** Algunos filtros pesan el inicio. Di
   "Parmelia, non-custodial stablecoin payments, deployed on Arbitrum" en la primera
   frase (el guion ya lo hace).
5. **El texto escrito y el hablado deben coincidir.** Si la Description dice una cosa
   y el video transcribe otra, un verificador de consistencia lo marca. Usa las
   mismas frases clave en ambos.
6. **NO hagas keyword stuffing** (repetir "Arbitrum Arbitrum Arbitrum" o meter texto
   oculto). Los filtros modernos penalizan el spam. Una mención clara y natural de
   cada término basta.
7. **Nombre del proyecto claro y temprano**: "Parmelia" dicho y subtitulado bien, no
   "Parmelya/Parmelia/Pamela". Que el filtro asocie el video con tu submission.
```
