export type TurnstileState =
	| { status: "disabled"; token: "" }
	| { status: "loading" | "expired" | "error"; token: null }
	| { status: "verified"; token: string };

export function turnstileReady(state: TurnstileState): boolean {
	return state.status === "disabled" || state.status === "verified";
}
