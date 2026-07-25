import { Suspense, lazy, useEffect, useState, type ReactNode } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sileo";
import { useTranslation } from "react-i18next";
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
const CrosschainSend = lazy(() => import("./pages/CrosschainSend"));
const CrosschainReceive = lazy(() => import("./pages/CrosschainReceive"));
const Receive = lazy(() => import("./pages/Receive"));
const Earn = lazy(() => import("./pages/Earn"));
const BinanceDeposit = lazy(() => import("./pages/BinanceDeposit"));
const Recover = lazy(() => import("./pages/Recover"));
const Security = lazy(() => import("./pages/Security"));

// Capture ?ref=<username> from invitation links before the router strips it;
// Onboarding attaches it to account creation for referral attribution.
const refParam = new URLSearchParams(window.location.search).get("ref");
if (refParam && /^[a-z0-9_-]{3,30}$/i.test(refParam)) {
	localStorage.setItem("parmelia:ref", refParam.toLowerCase());
}

function App() {
	const { t } = useTranslation();
	const [user, setUser] = useState<User | null>(null);
	const [loading, setLoading] = useState(true);
	const [hasWallet, setHasWallet] = useState<boolean | null>(null);
	// Flag, not a message: the copy is resolved with t() at render time so it
	// always follows the active language.
	const [walletCheckFailed, setWalletCheckFailed] = useState(false);

	const checkWallet = async (currentUser: User) => {
		try {
			const res = await fetchWithAuth(currentUser, `${SERVER_URL}/user/profile`);

			if (!res.ok) {
				throw new Error(`Profile request failed with status ${res.status}`);
			}

			const data = await res.json();
			setHasWallet(!!data.walletAddress);
			setWalletCheckFailed(false);
		} catch (error) {
			console.error("Wallet check failed", error);
			setHasWallet(null);
			setWalletCheckFailed(true);
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
				setWalletCheckFailed(false);
				void checkWallet(nextUser);
			} else {
				setHasWallet(null);
				setWalletCheckFailed(false);
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
					{walletCheckFailed ? t("app.walletCheckError") : t("app.loadingAccount")}
				</p>
				{walletCheckFailed && user && (
					<button
						onClick={() => {
							setLoading(true);
							setWalletCheckFailed(false);
							void checkWallet(user);
						}}
						className="mt-5 bg-parmelia-blue text-black px-6 py-2.5 rounded-full text-sm font-medium"
					>
						{t("common.retry")}
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
		if (user) {
			// "Lost your key?" tapped before signing in (Login saves the flag, same
			// pattern as parmelia:ref): consume it once and land on /recover instead
			// of Home. If the magic link opened in another browser the flag is simply
			// absent - the Home banner is the fallback entry.
			if (localStorage.getItem("parmelia:recover-intent")) {
				localStorage.removeItem("parmelia:recover-intent");
				return <Navigate to="/recover" />;
			}
			return <Navigate to="/" />;
		}
		return <Login />;
	}

	return (
		<BrowserRouter>
			<DesktopNotice />
			<Toaster
				position="top-center"
				theme="dark"
				offset={{ top: "calc(env(safe-area-inset-top) + 0.75rem)" }}
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
					<Route path="/scan" element={renderProtectedRoute(user ? <ScanQR user={user} /> : null)} />
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
						path="/receive"
						element={renderProtectedRoute(user ? <Receive user={user} /> : null)}
					/>
					<Route
						path="/crosschain"
						element={renderProtectedRoute(user ? <CrosschainSend user={user} /> : null)}
					/>
					<Route
						path="/earn"
						element={renderProtectedRoute(user ? <Earn user={user} /> : null)}
					/>
					<Route
						path="/deposit/binance"
						element={renderProtectedRoute(user ? <BinanceDeposit user={user} /> : null)}
					/>
					<Route
						path="/settings"
						element={renderProtectedRoute(user ? <Settings user={user} /> : null)}
					/>
					<Route
						path="/recover"
						element={renderProtectedRoute(user ? <Recover user={user} /> : null)}
					/>
					<Route
						path="/security"
						element={renderProtectedRoute(user ? <Security user={user} /> : null)}
					/>
					<Route path="/pay" element={<PayPage user={user} />} />
					<Route path="/pay/status" element={<PaymentStatus user={user} />} />
					<Route path="/cc/:recipient" element={<CrosschainReceive />} />
					<Route path="/:username" element={<PayPage user={user} />} />
				</Routes>
				</Suspense>
			</ErrorBoundary>
		</BrowserRouter>
	);
}

export default App;
