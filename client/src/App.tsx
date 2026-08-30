import { Suspense, lazy, useEffect, useRef, useState, type ReactNode } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router";
import { mutate as mutateSWR } from "swr";
import { isFirebaseEmailLink, onAuthChange, type User } from "./lib/firebase";
import ErrorBoundary from "./components/ErrorBoundary";
import DesktopNotice from "./components/DesktopNotice";
import AccountLaunchScreen from "./components/AccountLaunchScreen";
import ToastViewport from "./components/ToastViewport";
import ScrollToTop from "./components/ScrollToTop";
import { SERVER_URL } from "./lib/api";
import { initAnalytics } from "./lib/analytics";
import { activeNetwork } from "./lib/activeNetwork";
import {
	fetchHomeModel,
	loadHomeCache,
	saveHomeCache,
} from "./lib/homeData";
import { writeStorage } from "./lib/storageMigration";

const REF_STORAGE_KEY = "gatopago:ref";

// Lazy-load pages so each route ships as its own chunk and the initial bundle stays small.
const Login = lazy(() => import("./pages/Login"));
const Onboarding = lazy(() => import("./pages/Onboarding"));
const loadHome = () => import("./pages/Home");
const loadMove = () => import("./pages/Move");
const loadPayPage = () => import("./pages/PayPage");
const loadSwap = () => import("./pages/Swap");
const loadStatement = () => import("./pages/Statement");
const loadReceive = () => import("./pages/Receive");
const loadEarn = () => import("./pages/Earn");
const Home = lazy(loadHome);
const Move = lazy(loadMove);
const CreateLink = lazy(() => import("./pages/CreateLink"));
const PayPage = lazy(loadPayPage);
const PaymentStatus = lazy(() => import("./pages/PaymentStatus"));
const Settings = lazy(() => import("./pages/Settings"));
const ScanQR = lazy(() => import("./pages/ScanQR"));
const Swap = lazy(loadSwap);
const Statement = lazy(loadStatement);
const Contacts = lazy(() => import("./pages/Contacts"));
const CrosschainSend = lazy(() => import("./pages/CrosschainSend"));
const CrosschainReceive = lazy(() => import("./pages/CrosschainReceive"));
const Receive = lazy(loadReceive);
const Earn = lazy(loadEarn);
const Recover = lazy(() => import("./pages/Recover"));
const Security = lazy(() => import("./pages/Security"));
const Profile = lazy(() => import("./pages/Profile"));
const TestFunds = lazy(() => import("./pages/TestFunds"));
const DesignPreview = import.meta.env.DEV
	? lazy(() => import("./pages/DesignPreview"))
	: null;

// Capture ?ref=<username> from invitation links before the router strips it;
// Onboarding attaches it to account creation for referral attribution.
const refParam = new URLSearchParams(window.location.search).get("ref");
if (refParam && /^[a-z0-9_-]{3,30}$/i.test(refParam)) {
	writeStorage(REF_STORAGE_KEY, refParam.toLowerCase());
}

function App() {
	const [user, setUser] = useState<User | null>(null);
	const [loading, setLoading] = useState(true);
	const [hasWallet, setHasWallet] = useState<boolean | null>(null);
	const walletCheckRunRef = useRef(0);
	const [walletCheckFailed, setWalletCheckFailed] = useState(false);

	const checkWallet = async (currentUser: User) => {
		const runId = ++walletCheckRunRef.current;
		let usableCache = false;
		try {
			const cached = await loadHomeCache(
				currentUser.uid,
				activeNetwork.chainId,
			);
			if (runId !== walletCheckRunRef.current) return;

			// A previously validated wallet is enough to render immediately. The
			// authenticated API still authorizes every action; this cache only avoids
			// blocking the shell while /home revalidates in the background.
			if (cached?.model.account.walletAddress) {
				usableCache = true;
				await mutateSWR(`${SERVER_URL}/home`, cached.model, { revalidate: false });
				if (runId !== walletCheckRunRef.current) return;
				setHasWallet(true);
				setWalletCheckFailed(false);
				setLoading(false);
			}

			const { model, etag } = await fetchHomeModel(
				currentUser,
				`${SERVER_URL}/home`,
				cached,
				activeNetwork.chainId,
			);
			if (runId !== walletCheckRunRef.current) return;
			void saveHomeCache(
				currentUser.uid,
				activeNetwork.chainId,
				model,
				etag,
			);
			// Seed Home's canonical SWR key. Mounting Home does not create a
			// second request after this account gate.
			await mutateSWR(`${SERVER_URL}/home`, model, { revalidate: false });
			if (runId !== walletCheckRunRef.current) return;
			setHasWallet(!!model.account.walletAddress);
			setWalletCheckFailed(false);
		} catch (error) {
			console.error("Wallet check failed", error);
			if (runId !== walletCheckRunRef.current) return;
			// Keep a locally known account usable during a transient backend failure.
			// Mutating operations remain protected by the authenticated server.
			if (!usableCache) {
				setHasWallet(null);
				setWalletCheckFailed(true);
			}
		} finally {
			if (runId === walletCheckRunRef.current) setLoading(false);
		}
	};

	useEffect(initAnalytics, []);

	useEffect(() => {
		if (hasWallet !== true) return;
		// Keep the first bundle small, then warm the four primary destinations and
		// their immediate money flows once the authenticated shell is interactive.
		// This removes the one-time route-chunk pause without delaying Home.
		const timer = window.setTimeout(() => {
			void Promise.allSettled([
				loadHome(),
				loadMove(),
				loadEarn(),
				loadStatement(),
				loadPayPage(),
				loadReceive(),
				loadSwap(),
			]);
		}, 150);
		return () => window.clearTimeout(timer);
	}, [hasWallet]);

	useEffect(() => {
		const unsub = onAuthChange((nextUser) => {
			walletCheckRunRef.current++;
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
		return <AccountLaunchScreen failed={walletCheckFailed} onRetry={user ? () => {
			setLoading(true);
			setWalletCheckFailed(false);
			void checkWallet(user);
		} : undefined} />;
	}

	const splash = <AccountLaunchScreen />;

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
		// Firebase may update auth state before Login has exchanged a recovery
		// challenge. Keep the action-link landing mounted until it sanitizes the URL.
		if (isFirebaseEmailLink()) {
			return <Login />;
		}
		if (loading) {
			return splash;
		}
		if (user) {
			return <Navigate to="/" />;
		}
		return <Login />;
	}

	return (
		<BrowserRouter>
			<ScrollToTop />
			<DesktopNotice />
			<ToastViewport />
			<ErrorBoundary>
				<Suspense
					fallback={<AccountLaunchScreen />}
				>
					<Routes>
					<Route path="/login" element={renderLoginRoute()} />
					{DesignPreview ? <Route path="/__design/meli" element={<DesignPreview />} /> : null}
					<Route path="/onboarding" element={renderOnboardingRoute()} />
					<Route path="/" element={renderProtectedRoute(user ? <Home user={user} /> : null)} />
					<Route path="/move" element={renderProtectedRoute(<Move />)} />
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
					<Route path="/deposit/binance" element={renderProtectedRoute(<Navigate to="/receive" replace />)} />
					<Route
						path="/profile"
						element={renderProtectedRoute(user ? <Profile user={user} /> : null)}
					/>
					<Route
						path="/settings"
						element={renderProtectedRoute(user ? <Settings user={user} /> : null)}
					/>
					<Route
						path="/settings/security"
						element={renderProtectedRoute(user ? <Security user={user} /> : null)}
					/>
					<Route
						path="/settings/security/recovery"
						element={renderProtectedRoute(user ? <Recover user={user} /> : null)}
					/>
					<Route
						path="/test-funds"
						element={renderProtectedRoute(user ? <TestFunds user={user} /> : null)}
					/>
					<Route
						path="/recover"
						element={renderProtectedRoute(<Navigate to="/settings/security/recovery" replace />)}
					/>
					<Route
						path="/security"
						element={renderProtectedRoute(<Navigate to="/settings/security" replace />)}
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
