# Runbook: drift de proyección de balances

## Señal

`/health` devuelve `status=degraded` y
`warnings=["balance_projection_drift"]`, o aparece el evento estructurado
`balance_projection_drift`.

Parmelia compara valores raw, no strings redondeados de UI. Para USDC la
tolerancia inicial es cero.

## Comportamiento automático

1. El valor leído coherentemente por RPC permanece como snapshot visible.
2. Se escribe una fila inmutable en `balance_reconciliation_audits`.
3. La política del activo se degrada a `rpc_only`.
4. Home sigue sirviendo el último valor evidenciado; nunca lo convierte en cero.
5. El journal y los deltas se conservan para análisis/replay.

## Diagnóstico

Consultar sin exponer datos de otros usuarios:

```sql
SELECT id, chain_id, asset, projection_version, projected_raw, onchain_raw,
       drift_raw, block_number, block_hash, correction_reason, checked_at
FROM balance_reconciliation_audits
WHERE outcome = 'drift'
ORDER BY checked_at DESC
LIMIT 50;
```

Verificar después:

- checkpoint `erc20_transfers:<chainId>` y su hash;
- rango/bloque del primer delta divergente;
- address allowlisted del contrato;
- logs `removed`;
- incidentes de reorg;
- cambio de proxy/implementation/ABI;
- cursor saltado o backfill incompleto;
- que un self-transfer tenga delta neto cero.

## Recuperación

1. Mantener la política en `rpc_only`.
2. Corregir el normalizador/proyector en una versión nueva; no editar deltas.
3. Reconstruir la versión nueva desde un baseline canónico.
4. Comparar ambas versiones sobre una muestra y ventana suficientes.
5. Exigir drift raw cero para USDC.
6. Promover primero a `events_plus_rpc`.
7. Sólo después de la ventana acordada promover a `events`.
8. Registrar operador, evidencia, bloque y versión en el cambio.

No borrar auditorías para hacer desaparecer la alerta. La condición se cierra
mediante una migración/acción operativa que archive el incidente y promueva una
versión corregida.
