# BENCH_PEANUT.md — Benchmark Peanut vs Parmelia

> Versión 1.0 — julio 2026. Fuente: 40 capturas de la app de Peanut (beta,
> Android) tomadas por Daniel + peanut.me + producto Parmelia actual.
> Formato de decisión: qué copiar, qué adaptar al corredor boliviano, qué
> ignorar deliberadamente. No es un ejercicio de vanidad: cada fila termina
> en una acción o en un "no, y por qué".

---

## 1. Qué es Peanut hoy (observado, no marketing)

- **Balance unificado en USD** (multitoken/multichain abstraído a un número).
- **Depósito universal**: UNA dirección EVM para 9 redes (Arbitrum, Ethereum,
  Base, OP, BNB, Polygon, Katana, Gnosis, Celo) + Solana + Tron; USDT/USDC/ETH;
  auto-bridge ±0.1%; min $5; tooltip "para montos exactos deposita USDC en
  **Arbitrum**" — su chain madre es la misma nuestra.
- **Scan-to-pay multi-riel**: el escáner lee QRs de PEANUT, **Mercado Pago**,
  **PIX** y EVM. En su actividad: pagos reales a KFC y McDonald's con
  equivalencia en ARS. Pagan el mundo fiat desde saldo cripto (AR/BR).
- **Entrada/salida fiat por país**: Add money por transferencia bancaria (con
  KYC); Withdraw por país. **Bolivia aparece en la lista pero "To Bank: Soon!"**
  — solo retiro cripto hoy. Señalaron intención; no tienen los rieles.
- **Send/Request**: por link (sin cuenta), contactos, banco, Mercado Pago,
  exchange/wallet. Request con QR y monto abierto.
- **Growth integrado al producto**: Rewards ($ por reclamar al gastar), puntos
  y tiers, **grafo visual de referidos**, revshare por actividad de invitados,
  bug bounty de $5, badges públicos (Devconnect), tarjeta Visa con waitlist
  gamificada ("The door" — el badge te salta la fila) e imagen compartible.
- **Educación contextual excelente**: página de Backup (passkey + Google
  Password Manager) con "No backup = no recovery", modales "¿y si pierdo el
  teléfono?", "¿y si cambio de teléfono?" (honesto: iPhone↔Android no migra),
  "¿por qué no puedo exportar mi llave?"; explicador de KYC con privacidad.
- **Transparencia de tarifas**: pantalla calculadora (You send / Recipient
  gets, "Bank fee: Free!, Peanut fee: Free!").
- **Soporte**: tab fijo, Crisp con caras humanas + intake estructurado. (En la
  práctica a Daniel le falló — la promesa de UI no es la operación.)
- **Identidad**: neo-brutalismo (bordes gruesos, sombras duras, rosa/crema,
  mascota pixel), inglés-only, tono meme/cripto-nativo.

## 2. Dónde Peanut es objetivamente mejor (y qué hacemos)

| # | Ventaja Peanut | Acción Parmelia |
|---|---|---|
| B-1 | Depósito universal multichain (1 dirección, 9 redes, auto-bridge) | **Confirma la prioridad de Daimo Pay** en el hub Depositar: es el mismo primitivo, integrable sin partnership con cada exchange. |
| B-2 | Educación de respaldo/recuperación (la mejor educación passkey vista) | Añadir a Ajustes→Seguridad la sección "¿Qué pasa si pierdo mi teléfono?" con estados honestos. **Ventaja nuestra a gritar: tenemos guardian recovery on-chain — Peanut dice "tu dinero se pierde para siempre", nosotros PODEMOS recuperar.** Hoy no lo comunicamos. |
| B-3 | Multi-riel QR (Mercado Pago/PIX) — pagar el mundo fiat | Nuestro equivalente es **QR Simple vía Mesa de Pagos**. Peanut lo validó en AR/BR y **no tiene Bolivia** (banco "Soon!"). La ventana existe pero cierra: acelerar la conversación con Mesa de Pagos. |
| B-4 | Pantalla de tarifas transparente | Añadir "Tarifas" simple (app y landing): sin comisiones de red, swap X bps, crosschain Y. Barato, alta confianza. |
| B-5 | Soporte omnipresente (tab fijo, caras humanas) | Entrada de soporte visible (Ajustes + Home): WhatsApp/Telegram. En Bolivia, soporte por WhatsApp = confianza. Nuestra historia de origen ES un soporte que no respondió. |
| B-6 | Balance unificado en $ | **Decisión cerrada (jul-2026): NO copiar.** El saldo principal de Parmelia es USDC y solo USDC — nunca se suma un activo volátil al número principal ("mi plata no cambia sola" es la promesa central). Si algún día hay 3+ activos, viven en una sección aparte con valuación marcada como estimada. El "$" unificado de Peanut es correcto para su embudo multi-activo; el nuestro converge a USDC en la puerta de entrada (dirección universal v1 = solo USDC), lo que hace innecesaria la abstracción. |
| B-7 | Growth loops (puntos, tiers, revshare, waitlist gamificada) | **No copiar el casino de puntos ahora** (requiere ingresos que lo fondeen). Sí: waitlist con prioridad cuando llegue la tarjeta Gnosis; referidos ya los tenemos — subirles visibilidad llegado el momento. |

## 3. Dónde Parmelia es mejor (amplificar, no regalar)

| # | Ventaja Parmelia | Peanut |
|---|---|---|
| P-1 | **API de cobros + dashboard comerciante** (payment intents, webhooks firmados, sandbox, QR de mostrador) | No tiene historia B2B visible. Es nuestro foso. |
| P-2 | **Español primero** (527 keys es/en) | App inglés-only. Para el normie boliviano es barrera real. |
| P-3 | **Ahorro (Aave v3)** integrado no-custodial | No visto en Peanut. |
| P-4 | **Guardian recovery on-chain** | Peanut: "no backup = perdido para siempre". Nuestra recuperación es superior y no la contamos. |
| P-5 | Sin KYC en el core (cripto puro) | Peanut exige KYC para fiat y limita por regiones. Mantener mientras sea legal; el KYC fiat lo carga Mesa de Pagos. |
| P-6 | Checkout externo /cc (wallet cualquiera paga sin cuenta) | Equivalente parcial (links), pero nuestro flujo cobra-a-wallet-externa vía router es distinto. |
| P-7 | Comprobantes/recibos descargables, extracto con filtros | Más fintech-serio que su activity feed. |

## 4. Qué NO copiar (decisión cerrada)

1. **La estética neo-brutalista/meme**: es SU marca; copiarla nos hace la
   copia. La identidad Parmelia (dark elegante, glow, sobriedad fintech) es
   mejor para "confianza con dinero" en nuestro mercado.
2. **KYC + límites por región**: consecuencia de sus rieles bancarios propios;
   nuestro modelo delega el fiat a partners licenciados.
3. **Economía de puntos**: prematura sin ingresos; el revshare de Peanut lo
   fondea su fee futuro/inversores.
4. **Soporte prometido que no se cumple**: la lección es operativa, no de UI —
   responder de verdad vale más que 4 avatares.

## 5. Respuesta a "¿Peanut tiene mejor interfaz?"

No en conjunto — tiene **mejor sistema de marca dentro del producto** (cada
pantalla hace marketing: mascota, badges, tarjeta compartible), **mejor
cobertura de rampas** (su núcleo de negocio) y **mejor educación contextual**.
Parmelia tiene mejor arquitectura de flujos de dinero (confirmación uniforme,
estados pendiente/fallo honestos, resultado único), mejor historia B2B, y un
lenguaje visual más apropiado para el posicionamiento "tu dinero, en serio" en
LatAm. El gap real no es de estética: es B-1..B-5 de la tabla — rampas,
educación, tarifas y soporte visible.

## 6. Hallazgo estratégico principal

**Peanut ya señaló a Bolivia** (aparece en su lista de retiro) **pero no tiene
los rieles** ("To Bank: Soon!"). Comparten chain madre (Arbitrum) y categoría.
La ventana boliviana es real y tiene fecha de caducidad desconocida. La
respuesta no es pánico ni imitación: es velocidad en lo que ellos no pueden
comprar rápido — QR Simple/Mesa de Pagos, empresa local, soporte en español
que responde, y comercios integrados con nuestra API.

## 7bis. Actualización (lanzamiento viral de la tarjeta, jul-2026)

Fuente: post del equipo Peanut + review de terceros tras acceso por waitlist.
Datos nuevos confirmados sobre lo ya observado en §1:

- **Tarjeta Visa Platinum virtual LIVE y gratis** (física después); el review
  la lee correctamente: "no venden una tarjeta, venden una cuenta bancaria
  self-custodial en blockchain donde la tarjeta es solo una forma de gastar".
- **Rieles bancarios "gratis" en ~249 países** (SEPA, ACH, wires, Faster
  Payments, SPEI) vía proveedor bancario licenciado; sin límites duros en
  US/EU/MX. Bolivia sigue sin riel bancario (su propia app: "Soon").
- **Fee real único: spread FX del proveedor 0.5-0.8%.** Sin fees de depósito,
  retiro, QR ni transferencias.
- **Filosofía declarada**: "enviar dinero como un DM — free, instant, global";
  rewards SOLO por invitar (revshare multinivel en dinero real, no puntos):
  Metcalfe explícito. Sin cashbacks-token confusos (correcto y citable).
- **Momentum**: campaña viral en X esta semana; waitlist gamificada funcionó.
- **Limitaciones que su propio reviewer señala** (= nuestras aperturas):
  passkeys no migran entre Apple↔Google; **sin backup, dispositivo perdido =
  fondos perdidos** (nosotros: guardian recovery on-chain); periodo de espera
  del colateral tras pago con tarjeta; métodos locales solo en algunos países.

**Lo que cambia estratégicamente**: la arquitectura (smart wallet + passkeys +
Arbitrum + links gratis) ya es commodity — competir como "otra wallet
self-custodial de consumo" es una pelea perdida contra su capital y momentum.
Lo que NO cambia: no tienen historia B2B (ni API, ni dashboard, ni webhooks,
ni sandbox — cero mención comercios en todo el review), no tienen Bolivia
(riel "Soon", sin QR Simple, sin soporte es-first), no tienen Earn, y su tesis
de "accesibilidad como moat" **valida** la nuestra: si la accesibilidad gana,
el que clava el país más difícil de acceder gana ese país. Su geografía es
horizontal (249 países, someros); la nuestra es vertical (1 país, profundo).

## 7ter. Decisiones de la ronda "segundo análisis externo" (jul-2026)

Un análisis externo (agente sin acceso al repo) revisó nuestra lectura del
lanzamiento. Lo que se adopta, se corrige y se rechaza:

- **ADOPTADO — wording de recovery**: no prometer "perder tu teléfono no es
  perder tu dinero" (el guardian hoy es la llave del server; la promesa
  absoluta expone). Frase oficial: **"Recuperación segura: Parmelia te ayuda a
  recuperar el acceso sin custodiar tu dinero."**
- **ADOPTADO — estándar "verdad ganada"**: un diferenciador cuenta cuando un
  cliente lo usa, no cuando está en el repo. El stack merchant está
  CONSTRUIDO y verificado (intents, webhooks firmados, dashboard, sandbox,
  docs públicas) pero no GANADO: falta el primer comercio en producción.
- **GAPS REALES detectados contra el checklist Stripe-completo**: (1) endpoint
  de refunds/devoluciones no existe; (2) no hay SDKs ni ejemplos por lenguaje
  (solo curl). → backlog API.
- **RECHAZADO — "dejar de parecer wallet"**: infraestructura pura estilo
  Stripe tiene arranque en frío en Bolivia (los comercios adoptan rieles donde
  ya hay pagadores; no hay sustrato de tarjetas). La wallet es el lado de la
  demanda de la red de cobros — Yape ganó así. Síntesis oficial: **el pitch
  lidera con cobros; el producto mantiene los dos lados.**
- **Posicionamiento (frase de trabajo)**: "Peanut construye la red global de
  consumo. Parmelia construye la red de dinero de un país — los dos lados:
  la gente que paga y los negocios que cobran."

## 7. Backlog accionable derivado (orden sugerido)

1. Comunicar guardian recovery (Ajustes→Seguridad + landing): "si pierdes tu
   teléfono, tu cuenta se recupera" — B-2/P-4. Esfuerzo: bajo. Impacto: alto.
2. Entrada de soporte WhatsApp/Telegram visible — B-5. Bajo/alto.
3. Pantalla/sección "Tarifas" transparente — B-4. Bajo/medio.
4. Acelerar Mesa de Pagos (requisitos, fees, piloto QR Simple) — B-3. El más
   estratégico.
5. Daimo Pay en hub Depositar — B-1. Medio/alto.
6. Waitlist tarjeta cuando Gnosis avance — B-7. Bajo (en su momento).
