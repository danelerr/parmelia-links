import { type ReactNode } from "react";
import { NavLink } from "react-router";
import { logOut, type User } from "../lib/firebase";
import { DOCS_URL } from "../lib/docs";
import Logo from "./Logo";

const NAV: { to: string; label: string }[] = [
	{ to: "/", label: "Resumen" },
	{ to: "/keys", label: "API keys" },
	{ to: "/webhooks", label: "Webhooks" },
	{ to: "/payments", label: "Pagos" },
	{ to: "/events", label: "Eventos" },
	{ to: "/sandbox", label: "Sandbox" },
];

function navClass({ isActive }: { isActive: boolean }) {
	return [
		"px-3.5 h-10 rounded-[12px] flex items-center text-[14px] font-medium transition-colors shrink-0",
		isActive ? "bg-sky/15 text-glow-sky" : "text-text-muted hover:text-text hover:bg-surface-2",
	].join(" ");
}

/** External link to the canonical API reference (opens the landing docs). */
function DocsLink() {
	return (
		<a
			href={DOCS_URL}
			target="_blank"
			rel="noopener noreferrer"
			className="px-3.5 h-10 rounded-[12px] flex items-center gap-1.5 text-[14px] font-medium text-text-muted hover:text-text hover:bg-surface-2 transition-colors shrink-0"
		>
			Documentación
			<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
				<path d="M7 17 17 7" />
				<path d="M7 7h10v10" />
			</svg>
		</a>
	);
}

export default function Layout({ user, children }: { user: User; children: ReactNode }) {
	return (
		<div className="flex min-h-dvh">
			{/* Sidebar (desktop) */}
			<aside className="hidden md:flex md:flex-col w-64 shrink-0 border-r border-border px-4 py-6 gap-1">
				<div className="flex items-center gap-2.5 px-2 mb-6">
					<Logo className="w-7" />
					<div className="leading-tight">
						<p className="font-display text-[15px]">GatoPago</p>
						<p className="text-[12px] text-text-faint">Negocios</p>
					</div>
				</div>
				<nav className="flex flex-col gap-1">
					{NAV.map((n) => (
						<NavLink key={n.to} to={n.to} end={n.to === "/"} className={navClass}>
							{n.label}
						</NavLink>
					))}
					<DocsLink />
				</nav>
				<div className="mt-auto pt-4 border-t border-border">
					<p className="text-[12px] text-text-faint px-2 mb-2 truncate">{user.email}</p>
					<button onClick={() => logOut()} className="btn btn-ghost btn-sm btn-block">
						Cerrar sesión
					</button>
				</div>
			</aside>

			{/* Mobile top bar */}
			<div className="flex-1 flex flex-col min-w-0">
				<header className="md:hidden sticky top-0 z-10 bg-bg/90 backdrop-blur border-b border-border px-4 py-3 flex items-center gap-3">
					<Logo className="w-6 shrink-0" />
					<nav className="flex gap-1 overflow-x-auto">
						{NAV.map((n) => (
							<NavLink key={n.to} to={n.to} end={n.to === "/"} className={navClass}>
								{n.label}
							</NavLink>
						))}
						<DocsLink />
					</nav>
					<button onClick={() => logOut()} className="btn-text shrink-0 ml-auto">
						Salir
					</button>
				</header>

				<main className="flex-1 w-full max-w-[1080px] mx-auto px-5 md:px-10 py-8 animate-fade-up">
					{children}
				</main>
			</div>
		</div>
	);
}
