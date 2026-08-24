export type TurnstileState =
	| { status: "disabled"; token: "" }
	| { status: "loading"; token: null }
	| { status: "verified"; token: string }
	| { status: "expired"; token: null }
	| { status: "error"; token: null };

export function isTurnstileReady(state: TurnstileState): boolean {
	return state.status === "disabled" || state.status === "verified";
}
