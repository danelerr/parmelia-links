# UX_DESIGN.md — Revisión UX/UI y arquitectura de información

> Versión 1.0 — julio 2026. Documento de decisión, como CROSSCHAIN_DESIGN.md y
> DEFI_DESIGN.md: diagnóstico, reglas cerradas y plan por fases. La pregunta que
> responde: **¿cómo muestra Parmelia muchas funcionalidades (pagos, links,
> swap, ahorro, crosschain, depósitos, y pronto tarjeta y rampas) sin dejar de
> sentirse simple?**

---

## 1. Principio rector

**Home no es un menú: es el estado de tu dinero más dos verbos.**

Las apps de pago que escalaron features sin degradarse (Nubank, Revolut, Cash
App, Mercado Pago) comparten una regla: el número de acciones visibles en la
pantalla principal es *constante*. Las funcionalidades nuevas no agregan
botones a Home; entran dentro de **hubs por intención**. Parmelia ya tiene la
mitad de esta disciplina (2 primarias + 2 secundarias); este documento la
convierte en regla explícita antes de que lleguen tarjeta, Daimo, QR boliviano
y Gnosis Pay.

Las cuatro intenciones del usuario de Parmelia:

| Intención | Verbo del usuario | Superficie |
|---|---|---|
| Pedir dinero a alguien | "Cobrar" | `/charge` (link, QR) |
| Enviar dinero a alguien | "Pagar" | `/send` (scan, usuario, 0x, otra red) |
| Meter mi propio dinero | "Depositar" | hub dinero-entra (§4) |
| Hacer crecer / mover mi dinero | "Ahorro", "Cambiar" | `/earn`, `/swap` |

La tarjeta, cuando exista, es una quinta intención ("gastar en el mundo
físico") con superficie propia.

---

## 2. Qué está bien (fortalezas a proteger, no tocar)

1. **Sistema de diseño real** en `index.css`: tokens de color/elevación/radio,
   semántica de botones (`.btn-primary` acción, `.btn-ghost` secundaria,
   `.btn-text` terciaria) y — la mejor regla del sistema — **`.btn-gradient`
   reservado exclusivamente al CTA que mueve dinero**. Respeta
   `prefers-reduced-motion`, tiene `:focus-visible` y view transitions.
2. **Disciplina en los flujos de dinero**: prepare → firma biométrica → submit
   con micro-estados, sheet de confirmación antes de envíos irreversibles,
   TrustBadge en pagos, copy de riesgo obligatoria en Ahorro, estados
   pendiente/fallo honestos (jul-2026).
3. **i18n completo** (es/en, paridad verificada) y accesibilidad básica bien
   hecha (`aria-pressed` en segmentados, `aria-live` en estados, diálogos con
   manejo de foco vía `useDialog`).
4. **Labels sin jerga**: "Enviar a otra red", no "bridge CCTP". Mantener.
5. **Empty states que venden** ("Crea tu primer link de cobro"). Mantener.

---

## 3. Diagnóstico: problemas concretos

### 3.1 Arquitectura de información (los graves)

**P-1. "Dinero entra" está dentro de "Cobrar" — modelo mental roto.**
Recibir en blockchain (`/receive`), Depositar desde otra red (`/deposit`) y
Depositar desde Binance (`/deposit/binance`) solo son alcanzables desde
CreateLink → "Otras opciones". Pero *cobrar* (pedirle a una persona) y
*depositar* (traer mi propio dinero) son trabajos distintos. El usuario nuevo
con USDC en Binance — el caso de fondeo más común — tiene que adivinar que su
camino empieza en "Cobrar". Es el problema de IA número uno de la app.

**P-2. Enviar a otra red está enterrado.** `/crosschain` (CCTP a 3+ redes,
una funcionalidad entera con tracking en vivo) solo aparece como OptionCard
dentro de PayPage *en modo manual*. Invisible para quien no abre "Pagar" sin
link.

**P-3. Dos rieles para "mover entre redes" con nombres distintos en lugares
distintos.** `/deposit` (Across, bajo Cobrar, "Depositar desde otra red") y
`/crosschain` (CCTP, bajo Pagar, "Pagar a otra red") confunden el modelo
mental. La retirada de Across ya está decidida (CROSSCHAIN_DESIGN Fase 1,
gated en el smoke E2E del Flow A); esta revisión la confirma desde UX:
eliminar `/deposit` resuelve P-3 sin trabajo de diseño.

**P-4. Contactos escondido en Ajustes.** Soporta pagar en 1 tap (frecuencia
alta) pero su único acceso es Settings → "Contactos e invitaciones"
(frecuencia baja). El referral —motor de crecimiento— también vive ahí.

**P-5. Back inconsistente.** La mayoría vuelve a `/`, pero Contacts vuelve a
`/settings` y BinanceDeposit a `/charge`. Regla simple: el back vuelve a la
pantalla desde la que se llegó; los hubs definen la jerarquía.

### 3.2 Consistencia visual (los medianos)

**P-6. Earn está fuera del sistema de botones.** Usa clases custom
(`h-[52px] rounded-2xl bg-sky text-ink`) en vez de `.btn`; es la única página
así. Además su confirmación es full-screen mientras Pay y Crosschain usan
bottom sheet. **El momento "confirmar que se mueve dinero" debe ser idéntico
en toda la app** — es memoria muscular y es seguridad: el usuario debe
reconocer el patrón antes de poner la huella.

**P-7. Duplicación estructural que fabrica inconsistencia.** El mapeo
encontró: botón atrás repetido ~13 veces en 5 implementaciones distintas;
overlay de etapas copiado 3 veces (y Earn diverge con una línea de texto);
pantalla de éxito/estado replicada 5-6 veces en vez de reutilizar la canónica
(PaymentStatus); sheet de confirmación 2 copias + 2 variantes; chips de red 3
copias; tarjeta dirección+QR 2 copias; spinner brand ~8 copias; el contenedor
de pantalla repetido literal en ~15 páginas. Cada copia es un lugar donde la
próxima mejora (como los estados pending/failed de jul-2026) hay que aplicarla
N veces — y donde se olvida una.

### 3.3 Detalles menores

- El estado "link ya pagado" de PayPage replica el check en vez de reutilizar
  el patrón de resultado.
- Statement redibuja los iconos enviar/recibir de Home.
- `/cc/:recipient` no tiene ningún acceso in-app además de Receive (correcto
  para un checkout externo, pero Receive es casi inalcanzable — ver P-1).

---

## 4. Propuesta de IA: hubs por intención

### 4.1 Home (fase actual — sin tab bar)

```
[ Saldo + píldora ahorro ]
[ Cobrar ]        [ Pagar ]          <- primarias, sin cambios
[ Depositar ] [ Cambiar ] [ Ahorro ] <- secundarias: 3 tiles
[ Actividad reciente ]
```

Cambios respecto a hoy: entra el tile **Depositar** (hub dinero-entra) a las
secundarias. Cuando exista la tarjeta, la fila pasa a 2×2 (Depositar, Cambiar,
Ahorro, Tarjeta) y **se cierra**: ningún tile más, nunca. Todo lo posterior
entra dentro de un hub.

### 4.2 Hub "Depositar" (evolución de `/receive`)

Una sola pantalla con las formas de meter dinero, ordenadas por probabilidad:

1. **Mi dirección USDC en Arbitrum** (dirección + QR — hoy en Receive).
2. **Desde Binance** (hoy: guía de retiro; mañana: botón One-Click vía Daimo —
   *misma posición, mejora invisible*; el usuario no nota el cambio de
   plumbing, solo que ahora es un tap).
3. **Desde otra red** (link `/cc/usuario` — hoy en Receive avanzado).
4. *Futuro:* QR boliviano (Mesa de Pagos), otros exchanges vía Daimo.

CreateLink vuelve a ser **solo Cobrar** (link/QR); desaparece su bloque "Otras
opciones". BinanceDeposit y Receive se absorben en el hub; `/deposit` (Across)
se retira según el gate ya definido.

### 4.3 Pagar

- El OptionCard "Pagar a otra red" pasa a ser visible **siempre** en PayPage
  (no solo en modo manual).
- **Contactos frecuentes arriba del formulario manual**: fila de avatares
  tappables (pagar a un amigo = la razón de existir de Contacts). La gestión
  (agregar, invitar, borrar) se queda en Settings; el *uso* vive en Pagar.

### 4.4 Tarjeta (cuando exista) y el trigger de la tab bar

La tarjeta no es un flujo, es un *lugar*: estado propio (últimos consumos,
congelar, datos, PIN) que se visita a diario. Hub-and-spoke aguanta bien hasta
~6 destinos de frecuencia media; una superficie de frecuencia diaria lo
rompe.

**Gate G-UX1 (medible): se introduce navegación inferior (tab bar) cuando la
tarjeta esté en producción**, no antes. Candidato: `Inicio · Extracto ·
Tarjeta · Ajustes` (4 tabs; Cobrar/Pagar siguen siendo las primarias *dentro*
de Inicio — el dinero P2P es la identidad de Parmelia y no se relega a un
tab). Mientras no haya tarjeta, agregar tab bar sería estructura sin
contenido.

---

## 5. Reglas cerradas (para no re-debatir)

| # | Regla |
|---|---|
| R-1 | Home: saldo + 2 primarias (Cobrar/Pagar) + máx. 4 tiles secundarias. Nada entra sin que algo salga. |
| R-2 | Toda funcionalidad nueva entra en el hub de su intención (Depositar / Pagar / Ahorro), no en Home. |
| R-3 | `.btn-gradient` sigue reservado al único CTA que mueve dinero on-chain. |
| R-4 | Confirmar-dinero es SIEMPRE el mismo bottom sheet (monto grande, destino, advertencia, `btn-gradient` + cancelar texto). Sin variantes full-screen ni inline. |
| R-5 | Resultado de operación es SIEMPRE el mismo componente con 3 estados (éxito / pendiente-polling / fallo). |
| R-6 | Labels en lenguaje de usuario, nunca de protocolo. Los empty states venden la función. |
| R-7 | Tab bar solo cuando la tarjeta esté en producción (G-UX1). |
| R-8 | Mejoras de rampa (Daimo, Mesa de Pagos) reemplazan el contenido de un slot existente del hub Depositar; no crean entradas nuevas. |

---

## 6. Plan por fases

### Fase UX-1 — Coherencia (solo refactor, cero cambio de comportamiento) — HECHA (jul-2026)

Extraer los componentes compartidos que eliminan las ~40 duplicaciones:

| Componente | Reemplaza | Copias hoy |
|---|---|---|
| `Screen` (contenedor safe-area) | string repetido en páginas | ~15 |
| `BackHeader` (`to`/`onClick` + título) | 5 implementaciones de back | ~13 |
| `StageOverlay` (preparing/signing/sending) | PayingOverlay + 2 StageOverlay | 3 (+Earn que diverge) |
| `TxResult` (éxito/pendiente/fallo + monto + explorer) | pantallas de éxito propias | 5-6 |
| `ConfirmSheet` (confirmación de dinero) | ManualConfirmSheet + ConfirmSendSheet + Earn full-screen | 2+2 |
| `NetworkChips` | chips de red | 3 |
| `AddressQRCard` | tarjeta dirección+QR | 2 |
| `icons.tsx` (Check, Cross, Back, Copy, Spinner, Send, Receive, Chevron…) | SVGs inline | ~30 |

Además: Earn migra a `.btn*` y a `ConfirmSheet`; backs según regla única.

### Fase UX-2 — Arquitectura de información — HECHA (jul-2026), salvo #5

1. Hub **Depositar** (`/receive`: dirección+QR, Binance, Across, link cc) + tile en Home. HECHO.
2. CreateLink queda puro Cobrar (se fue "Otras opciones"). HECHO.
3. "Pagar a otra red" en PayPage: ya vivía en la pantalla principal de Pagar
   (modo manual, que es a donde lleva el botón de Home) — sin cambio necesario.
4. Contactos de un tap en PayPage (fila de avatares sobre el formulario). HECHO.
5. Retirar `/deposit` (Across) — sigue gated en CROSSCHAIN_DESIGN Fase 1
   (smoke E2E del Flow A); hoy es un slot del hub Depositar.

### Fase UX-3 — Con la tarjeta

1. Tile Tarjeta en Home (cierra la fila 2×2).
2. Tab bar según G-UX1.
3. Slot Binance del hub Depositar cambia de guía a One-Click (Daimo).

---

## 6bis. Extracción del análisis UX externo (jul-2026)

Un análisis externo (26 capturas Parmelia vs 43 de Peanut, sin acceso al repo)
propuso un rediseño amplio. Decisión del fundador: **NO al rediseño de Home y
NO a la barra inferior** (coherente con R-1 y R-7). Lo que se extrae:

**ADOPTADO (nuevo, valioso):**
1. **Microcopy de confianza en el momento de la firma**: "Parmelia no puede
   mover tu dinero sin ti." — va en el ConfirmSheet compartido (todos los
   flujos lo heredan). Y para Seguridad: "Parmelia no puede congelar, mover ni
   gastar tu dinero."
2. **El cobro como objeto vivo**: lista "Mis cobros" en la app con estado
   (pendiente/pagado/expirado), compartir directo a WhatsApp, "ver como
   cliente", y expiración opcional al crear. Hoy el link de consumo es
   crear-y-olvidar; el estado ya existe en el server.
3. **Checkout externo /cc métodos-primero**: hoy lidera con redes (chips) y
   "conectar wallet" — demasiado crypto. Reordenar como checkout de pagos:
   destinatario + monto → métodos (Pagar con Parmelia / desde Binance / con
   wallet / desde otra red) → redes dentro de "avanzado". El usuario piensa
   "con qué plata pago", no "desde qué chain".
4. **Centro de seguridad**: subir la seguridad de Ajustes a narrativa — estado
   de llaves (principal activa / respaldo pendiente / recuperación activa) +
   FAQ "¿qué pasa si pierdo mi teléfono?". Se fusiona con el backlog #1 del
   bench (comunicar guardian recovery, wording ya fijado en BENCH §7ter).
5. **"Mi QR" dentro de ScanQR** (toggle escanear ↔ mostrar mi QR): resuelve el
   trabajo "QR persistente" de Peanut sin tab bar ni tocar Home.
6. **Etiqueta "Dólares digitales disponibles"** bajo el saldo USDC — narrativa
   de cuenta, no de wallet. Microcambio.

**YA HECHO O YA DECIDIDO (el análisis no vio el repo):** hub Depositar
métodos-primero (UX-2), fila de contactos en Pagar, comprobantes shareables,
soporte visible + tarifas transparentes + recovery comunicado (bench §7),
confirmación uniforme (R-4), estados pendiente/fallo honestos, borde gradiente
como firma en momentos de dinero, "no copiar" de Peanut (bench §4).

**RECHAZADO (con razón):** barra inferior y rediseño de Home (fundador + R-1 +
R-7); botón QR flotante central (variante de tab bar); renombrar Depositar →
"Entrar dinero" (Depositar es lenguaje bancario natural es-LA); hub "Sacar
dinero" (prematuro sin rieles bancarios — revisitar con Mesa de Pagos);
ejercicio de branding "Parmelia Layers" (los patrones ya existen; nombrarlos
no agrega); tarjeta "próximamente" en Home (tile para feature inexistente
viola R-1).

## 7. Preguntas cerradas

| Pregunta | Respuesta | Por qué |
|---|---|---|
| ¿Tab bar ahora? | No — gate G-UX1 (tarjeta en producción) | Estructura sin contenido; hub-and-spoke aguanta los destinos actuales |
| ¿Más tiles en Home para nuevas features? | No — R-1/R-2 | Home constante; hubs absorben el crecimiento |
| ¿Mantener dos rieles entre-redes visibles? | No — retirar Across (`/deposit`) | Ya decidido en CROSSCHAIN_DESIGN; UX lo confirma (P-3) |
| ¿Confirmación de Earn full-screen? | No — mismo ConfirmSheet que Pay/Crosschain (R-4) | El momento de la huella debe ser idéntico siempre |
| ¿Dónde viven las rampas futuras (Daimo, Mesa de Pagos, QR boliviano)? | Slots del hub Depositar (R-8) | El usuario aprende un solo lugar para "meter dinero" |
| ¿Contactos a Home? | No — uso en Pagar, gestión en Settings | Frecuencia de uso está en el momento de pagar, no como destino propio |
