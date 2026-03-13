import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sileo";
import { onAuthChange, type User } from "./firebase";
import Login from "./pages/Login";
import Home from "./pages/Home";
import CreateLink from "./pages/CreateLink";
import PayPage from "./pages/PayPage";
import PaymentStatus from "./pages/PaymentStatus";
import Settings from "./pages/Settings";
import ScanQR from "./pages/ScanQR";
import Logo from "./components/Logo";

function App() {
	const [user, setUser] = useState<User | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		const unsub = onAuthChange((u) => {
			setUser(u);
			setLoading(false);
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
					path="/"
					element={user ? <Home user={user} /> : <Navigate to="/login" />}
				/>
				<Route
					path="/cobrar"
					element={user ? <CreateLink user={user} /> : <Navigate to="/login" />}
				/>
				<Route
					path="/pagar"
					element={user ? <PayPage user={user} /> : <Navigate to="/login" />}
				/>
				<Route
					path="/scan"
					element={user ? <ScanQR /> : <Navigate to="/login" />}
				/>
				<Route path="/pay" element={<PayPage user={user} />} />
				<Route path="/pay/status" element={<PaymentStatus />} />
				<Route
					path="/settings"
					element={user ? <Settings user={user} /> : <Navigate to="/login" />}
				/>
				{/* Username-based payment routes like /daniel */}
				<Route path="/:username" element={<PayPage user={user} />} />
			</Routes>
		</BrowserRouter>
	);
}

export default App;