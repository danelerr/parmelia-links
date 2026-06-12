// Render-error boundary: without this, any uncaught render error (or a failed
// lazy chunk after a deploy) is a white screen. Shows a branded recovery
// screen instead. Class component — boundaries can't be hooks.

import { Component, type ReactNode } from "react";
import Logo from "./Logo";

type Props = { children: ReactNode };
type State = { hasError: boolean };

export default class ErrorBoundary extends Component<Props, State> {
	state: State = { hasError: false };

	static getDerivedStateFromError(): State {
		return { hasError: true };
	}

	componentDidCatch(error: unknown) {
		console.error("Render error:", error);
	}

	render() {
		if (!this.state.hasError) return this.props.children;
		return (
			<div className="flex flex-col items-center justify-center min-h-dvh px-8 text-center">
				<Logo className="w-14 mb-6 opacity-60" />
				<h1 className="font-display text-[22px] mb-2">Algo salió mal</h1>
				<p className="text-[14px] text-text-muted max-w-[280px] leading-relaxed mb-7">
					Tu dinero está seguro. Recarga la pantalla para continuar.
				</p>
				<button
					onClick={() => window.location.reload()}
					className="btn btn-primary btn-sm"
				>
					Recargar
				</button>
			</div>
		);
	}
}
