// Navigation that looks like a button. A real react-router <Link> (correct
// semantics: open in new tab, back/forward, focusable link role) styled with
// the exact same classes as the <button> it replaces. View transitions are on
// by default to match useViewTransitionNavigate's cross-fade.

import { Link, type LinkProps } from "react-router-dom";

export default function LinkButton({ viewTransition = true, ...props }: LinkProps) {
	return <Link viewTransition={viewTransition} {...props} />;
}
