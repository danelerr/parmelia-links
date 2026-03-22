import { useEffect, useState, type ReactNode } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sileo";
import { onAuthChange, type User } from "./firebase";
import { fetchWithAuth } from "./authFetch";
import Login from "./pages/Login";
import Onboarding from "./pages/Onboarding";
import Home from "./pages/Home";
import CreateLink from "./pages/CreateLink";
import PayPage from "./pages/PayPage";
import PaymentStatus from "./pages/PaymentStatus";
import Settings from "./pages/Settings";
import ScanQR from "./pages/ScanQR";
import Logo from "./components/Logo";

const SERVER_URL =
	import.meta.env.VITE_SERVER_URL || "https://server.parmelia.workers.dev";

function App() {
	const [user, setUser] = useState<User | null>(null);
	const [loading, setLoading] = useState(true);
	const [hasWallet, setHasWallet] = useState<boolean | null>(null);
	const [walletCheckError, setWalletCheckError] = useState("");

	const checkWallet = async (currentUser: User) => {
		try {
			const res = await fetchWithAuth(currentUser, `${SERVER_URL}/user/profile`);

			if (!res.ok) {
				throw new Error(`Profile request failed with status ${res.status}`);
			}

			const data = await res.json();
			setHasWallet(!!data.walletAddress);
			setWalletCheckError("");
		} catch (error) {
			console.error("Wallet check failed", error);
			setHasWallet(null);
			setWalletCheckError(
				"No pudimos validar tu cuenta todavía. Reintenta en un momento.",
			);
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		const unsub = onAuthChange((nextUser) => {
			setUser(nextUser);
			console.log("user", nextUser);

			if (nextUser) {
				setLoading(true);
				setWalletCheckError("");
				void checkWallet(nextUser);
			} else {
				setHasWallet(null);
				setWalletCheckError("");
				setLoading(false);
			}
		});
		return unsub;
	}, []);

	function renderAccountState() {
		return (
			<div className="flex flex-col items-center justify-center min-h-dvh px-6 text-center">
				<Logo className="w-20 animate-pulse" />
				<p className="text-sm text-muted mt-5 max-w-xs">
					{walletCheckError || "Cargando tu cuenta..."}
				</p>
				{walletCheckError && user && (
					<button
						onClick={() => {
							setLoading(true);
							setWalletCheckError("");
							void checkWallet(user);
						}}
						className="mt-5 bg-parmelia-blue text-black px-6 py-2.5 rounded-full text-sm font-medium"
					>
						Reintentar
					</button>
				)}
			</div>
		);
	}

	function renderProtectedRoute(content: ReactNode) {
		if (!user) {
			return <Navigate to="/login" />;
		}

		if (hasWallet === false) {
			return <Navigate to="/onboarding" />;
		}

		if (hasWallet === true) {
			return content;
		}

		return renderAccountState();
	}

	function renderOnboardingRoute() {
		if (!user) {
			return <Navigate to="/login" />;
		}

		if (hasWallet === true) {
			return <Navigate to="/" />;
		}

		if (hasWallet === false) {
			return <Onboarding user={user} onComplete={() => setHasWallet(true)} />;
		}

		return renderAccountState();
	}

	if (loading) {
		return (
			<div className="flex items-center justify-center min-h-dvh">
				<Logo className="w-20 animate-pulse" />
			</div>
		);
	}

	return (
		<BrowserRouter>
			<Toaster
				position="top-center"
				theme="dark"
				options={{
					fill: "#1a1a1a",
					roundness: 12,
					styles: {
						title: "text-white!",
						description: "text-white/75!",
						badge: "bg-white/10!",
						button: "bg-white/10! hover:bg-white/15!",
					},
				}}
			/>
			<Routes>
				<Route path="/login" element={user ? <Navigate to="/" /> : <Login />} />
				<Route path="/onboarding" element={renderOnboardingRoute()} />
				<Route path="/" element={renderProtectedRoute(user ? <Home user={user} /> : null)} />
				<Route
					path="/cobrar"
					element={renderProtectedRoute(user ? <CreateLink user={user} /> : null)}
				/>
				<Route
					path="/pagar"
					element={renderProtectedRoute(user ? <PayPage user={user} /> : null)}
				/>
				<Route path="/scan" element={renderProtectedRoute(<ScanQR />)} />
				<Route
					path="/settings"
					element={renderProtectedRoute(user ? <Settings user={user} /> : null)}
				/>
				<Route path="/pay" element={<PayPage user={user} />} />
				<Route path="/pay/status" element={<PaymentStatus />} />
				<Route path="/:username" element={<PayPage user={user} />} />
			</Routes>
		</BrowserRouter>
	);
}

export default App;
