export function serializeBigInts(obj: any): any {
	if (typeof obj === "bigint") {
		return obj.toString();
	}
	if (Array.isArray(obj)) {
		return obj.map(serializeBigInts);
	}
	if (obj !== null && typeof obj === "object") {
		return Object.fromEntries(
			Object.entries(obj).map(([key, value]) => [key, serializeBigInts(value)]),
		);
	}
	return obj;
}