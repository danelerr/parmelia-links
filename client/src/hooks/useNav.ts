import { useCallback } from "react";
import { useNavigate, type NavigateOptions, type To } from "react-router";

/**
 * useNavigate with the View Transitions API enabled by default, so route
 * changes cross-fade instead of cutting. Browsers without support (e.g.
 * Firefox) navigate instantly - the option is simply ignored. Numeric
 * deltas (e.g. navigate(-1)) don't accept options and pass through untouched.
 */
export function useViewTransitionNavigate() {
	const navigate = useNavigate();

	return useCallback(
		(to: To | number, options?: NavigateOptions) => {
			if (typeof to === "number") {
				navigate(to);
				return;
			}
			navigate(to, { viewTransition: true, ...options });
		},
		[navigate],
	);
}
