-- GatoPago brand cutover. Preserve every stored value while moving the live
-- cross-chain schema away from the previous product name.
ALTER TABLE crosschain_operations
	RENAME COLUMN parmelia_fee TO gatopago_fee;
