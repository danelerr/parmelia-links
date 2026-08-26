# Documentación técnica de GatoPago

**Última organización:** 23 de agosto de 2026  
**Estado:** índice canónico de documentación vinculada al código  
**Alcance:** arquitectura, API, contratos, diseños técnicos, operación, seguridad, auditorías y runbooks

La estrategia, narrativa y marca viven en la [documentación central de `parmelia-landing`](https://github.com/danelerr/parmelia-landing/tree/main/documentacion). Este repositorio conserva únicamente información que debe evolucionar junto a la implementación.

## Orden de precedencia

Cuando dos documentos se contradigan, se aplica este orden:

1. Código, migraciones, configuración ejecutable y estado de red verificado.
2. [`ARCHITECTURE.md`](../ARCHITECTURE.md) y [`SECURITY.md`](../SECURITY.md).
3. [`openapi.yaml`](./openapi.yaml), [referencia de API](./api.md) y [contrato de errores](./reference/error-codes.md).
4. Diseños técnicos de `design/`.
5. Runbook de [despliegue](../DEPLOY.md), integraciones y `runbooks/`.
6. [`roadmap.md`](./roadmap.md).
7. Auditorías fechadas e histórico; son evidencia de un corte, no verdad permanente.

## Mapa

### Núcleo

- [Arquitectura](../ARCHITECTURE.md)
- [Arquitectura visual y diagramas PlantUML](./architecture/README.md)
- [Correcciones y fundamentos de la separación Payments](./architecture/CORRECCIONES.md)
- [Seguridad](../SECURITY.md)
- [Despliegue](../DEPLOY.md)
- [Roadmap técnico](./roadmap.md)

### API

- [Diseño de la API](./design/api.md)
- [Referencia de uso](./api.md)
- [OpenAPI](./openapi.yaml)
- [Códigos de error](./reference/error-codes.md)

### Diseños

- [Cross-chain](./design/cross-chain.md)
- [Acceso de emergencia y soberanía de las cuentas](./design/emergency-account-access.md)
- [Plan propuesto: checkout universal y aceptación USDC en tres redes](./design/universal-checkout-multichain.md)
- [DeFi y Earn](./design/defi.md)

### Operación

- [Integraciones](./operations/integrations.md)
- [Inventario canónico de secretos y configuración](./operations/worker-variables.md)
- [Cierre remoto corregido de Fase 2.1 al 26-08-2026](./operations/phase-2-1-live-readiness-2026-08-26.md)
- [Reapertura histórica de Fase 2.1 al 25-08-2026](./operations/phase-2-1-live-readiness-2026-08-25.md)
- [Eventos muertos del outbox](./operations/user-event-outbox.md)
- [Capacidad de Home](./runbooks/home-capacity.md)
- [Drift de proyecciones](./runbooks/projection-drift.md)
- [Reorganizaciones](./runbooks/reorg.md)
- [RPC e indexación](./runbooks/rpc-operations.md)
- [Corte App → Payments sin perder escrituras](./runbooks/payments-cutover.md)
- [Reemplazo semántico del corte Payments histórico](./runbooks/payments-semantic-recut.md)

### Evidencia

- [Auditoría técnica del 23 de agosto de 2026](./audits/2026-08-23.md)
- `audits/historico/`: auditorías anteriores que todavía explican decisiones o mediciones.
- `historico/`: planes reemplazados que conservan contexto arquitectónico.

Los README de `client/`, `server/` y `contracts/`, así como `contracts/AUDIT.md`, permanecen junto a sus componentes.

## Fuera del sistema documental

`.agents/skills/` contiene paquetes de tooling vendorizados y registrados en `skills-lock.json`. Sus Markdown no cuentan como documentación de producto y no deben moverse a esta carpeta.

## Mantenimiento

- Toda afirmación sobre disponibilidad debe distinguir código, despliegue y evidencia E2E.
- Un nuevo informe debe tener fecha, alcance, comandos ejecutados y límites.
- Al reemplazar un documento, se actualizan este índice y todas sus referencias.
- No se crean nuevos archivos `PLAN_*`, `MEJORAS_*`, `CODEX_*` o nombres de agente en la raíz.
- Ningún documento autoriza un deploy o cambio de red por sí solo.
