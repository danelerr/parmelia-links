import { useEffect, useState } from "react";
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

	// Check if user has a wallet
	const checkWallet = async (u: User) => {
		try {
			const res = await fetchWithAuth(u, `${SERVER_URL}/user/profile`);
			if (res.ok) {
				const data = await res.json();
				setHasWallet(!!data.walletAddress);
			} else {
				setHasWallet(false);
			}
		} catch {
			setHasWallet(false);
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		const unsub = onAuthChange((u) => {
			setUser(u);
			console.log("user", u);
			if (u) {
				checkWallet(u);
			} else {
				setHasWallet(null);
				setLoading(false);
			}
		});
		return unsub;
	}, []);

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

				<Route
					path="/onboarding"
					element={
						user && hasWallet === false ? (
							<Onboarding user={user} onComplete={() => setHasWallet(true)} />
						) : (
							<Navigate to="/" />
						)
					}
				/>
				{/* Protected Routes that require both Login AND Wallet */}
				<Route
					path="/"
					element={
						!user ? (
							<Navigate to="/login" />
						) : !hasWallet ? (
							<Navigate to="/onboarding" />
						) : (
							<Home user={user} />
						)
					}
				/>
				<Route
					path="/cobrar"
					element={
						!user ? (
							<Navigate to="/login" />
						) : !hasWallet ? (
							<Navigate to="/onboarding" />
						) : (
							<CreateLink user={user} />
						)
					}
				/>
				<Route
					path="/pagar"
					element={
						!user ? (
							<Navigate to="/login" />
						) : !hasWallet ? (
							<Navigate to="/onboarding" />
						) : (
							<PayPage user={user} />
						)
					}
				/>
				<Route
					path="/scan"
					element={
						!user ? (
							<Navigate to="/login" />
						) : !hasWallet ? (
							<Navigate to="/onboarding" />
						) : (
							<ScanQR />
						)
					}
				/>
				<Route
					path="/settings"
					element={
						!user ? (
							<Navigate to="/login" />
						) : !hasWallet ? (
							<Navigate to="/onboarding" />
						) : (
							<Settings user={user} />
						)
					}
				/>

				{/* Public or shared payment routes */}
				<Route path="/pay" element={<PayPage user={user} />} />
				<Route path="/pay/status" element={<PaymentStatus />} />
				{/* Username-based payment routes like /daniel */}
				<Route path="/:username" element={<PayPage user={user} />} />
			</Routes>
		</BrowserRouter>
	);
}

export default App;
