import { useLayoutEffect } from "react";
import { useLocation } from "react-router";

/** New screens always start at their top instead of inheriting the prior page scroll. */
export default function ScrollToTop() {
	const { pathname } = useLocation();

	useLayoutEffect(() => {
		window.scrollTo(0, 0);
	}, [pathname]);

	return null;
}
