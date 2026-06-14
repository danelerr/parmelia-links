import { Suspense, lazy, useEffect, useState, type ReactNode } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sileo";
import { onAuthChange, type User } from "./lib/firebase";
import { fetchWithAuth } from "./lib/authFetch";
import Logo from "./components/Logo";
import ErrorBoundary from "./components/ErrorBoundary";
import DesktopNotice from "./components/DesktopNotice";
import { SERVER_URL } from "./lib/api";
import { initAnalytics } from "./lib/analytics";

// Lazy-load pages so each route ships as its own chunk and the initial bundle stays small.
const Login = lazy(() => import("./pages/Login"));
const Onboarding = lazy(() => import("./pages/Onboarding"));
const Home = lazy(() => import("./pages/Home"));
const CreateLink = lazy(() => import("./pages/CreateLink"));
const PayPage = lazy(() => import("./pages/PayPage"));
const PaymentStatus = lazy(() => import("./pages/PaymentStatus"));
const Settings = lazy(() => import("./pages/Settings"));
const ScanQR = lazy(() => import("./pages/ScanQR"));
const Swap = lazy(() => import("./pages/Swap"));
const Statement = lazy(() => import("./pages/Statement"));
const Contacts = lazy(() => import("./pages/Contacts"));
const Deposit = lazy(() => import("./pages/Deposit"));

// Capture ?ref=<username> from invitation links before the router strips it;
// Onboarding attaches it to account creation for referral attribution.
const refParam = new URLSearchParams(window.location.search).get("ref");
if (refParam && /^[a-z0-9_-]{3,30}$/i.test(refParam)) {
	localStorage.setItem("parmelia:ref", refParam.toLowerCase());
}

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
		initAnalytics();
	}, []);

	useEffect(() => {
		const unsub = onAuthChange((nextUser) => {
			setUser(nextUser);

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

	const splash = (
		<div className="flex items-center justify-center min-h-dvh">
			<Logo className="w-20 animate-pulse" />
		</div>
	);

	function renderProtectedRoute(content: ReactNode) {
		if (loading) {
			return renderAccountState();
		}

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
		if (loading) {
			return splash;
		}

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

	function renderLoginRoute() {
		if (loading) {
			return splash;
		}
		return user ? <Navigate to="/" /> : <Login />;
	}

	return (
		<BrowserRouter>
			<DesktopNotice />
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
			<ErrorBoundary>
				<Suspense
					fallback={
						<div className="flex items-center justify-center min-h-dvh">
							<Logo className="w-20 animate-pulse" />
						</div>
					}
				>
					<Routes>
					<Route path="/login" element={renderLoginRoute()} />
					<Route path="/onboarding" element={renderOnboardingRoute()} />
					<Route path="/" element={renderProtectedRoute(user ? <Home user={user} /> : null)} />
					<Route
						path="/charge"
						element={renderProtectedRoute(user ? <CreateLink user={user} /> : null)}
					/>
					<Route
						path="/send"
						element={renderProtectedRoute(user ? <PayPage user={user} /> : null)}
					/>
					<Route path="/scan" element={renderProtectedRoute(<ScanQR />)} />
					<Route
						path="/swap"
						element={renderProtectedRoute(user ? <Swap user={user} /> : null)}
					/>
					<Route
						path="/statement"
						element={renderProtectedRoute(user ? <Statement user={user} /> : null)}
					/>
					<Route
						path="/contacts"
						element={renderProtectedRoute(user ? <Contacts user={user} /> : null)}
					/>
					<Route
						path="/deposit"
						element={renderProtectedRoute(user ? <Deposit user={user} /> : null)}
					/>
					<Route
						path="/settings"
						element={renderProtectedRoute(user ? <Settings user={user} /> : null)}
					/>
					<Route path="/pay" element={<PayPage user={user} />} />
					<Route path="/pay/status" element={<PaymentStatus />} />
					<Route path="/:username" element={<PayPage user={user} />} />
				</Routes>
				</Suspense>
			</ErrorBoundary>
		</BrowserRouter>
	);
}

export default App;
