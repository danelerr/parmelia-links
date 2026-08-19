import { Suspense, lazy, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { Toaster } from "sileo";
import { onAuthChange, type User } from "./lib/firebase";
import Logo from "./components/Logo";
import Layout from "./components/Layout";

const Login = lazy(() => import("./pages/Login"));
const Overview = lazy(() => import("./pages/Overview"));
const ApiKeys = lazy(() => import("./pages/ApiKeys"));
const Webhooks = lazy(() => import("./pages/Webhooks"));
const Payments = lazy(() => import("./pages/Payments"));
const Events = lazy(() => import("./pages/Events"));
const Sandbox = lazy(() => import("./pages/Sandbox"));
const PaymentDetail = lazy(() => import("./pages/PaymentDetail"));

function Splash() {
	return (
		<div className="flex items-center justify-center min-h-dvh">
			<Logo className="w-14 animate-fade-in" />
		</div>
	);
}

export default function App() {
	const [user, setUser] = useState<User | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => onAuthChange((u) => { setUser(u); setLoading(false); }), []);

	return (
		<BrowserRouter>
			<Toaster
				position="top-center"
				theme="dark"
				options={{ fill: "#1a1a1e", roundness: 12 }}
			/>
			<Suspense fallback={<Splash />}>
				{loading ? (
					<Splash />
				) : !user ? (
					<Routes>
						<Route path="*" element={<Login />} />
					</Routes>
				) : (
					<Layout user={user}>
						<Routes>
							<Route path="/" element={<Overview user={user} />} />
							<Route path="/keys" element={<ApiKeys user={user} />} />
							<Route path="/webhooks" element={<Webhooks user={user} />} />
							<Route path="/payments" element={<Payments user={user} />} />
							<Route path="/payments/:id" element={<PaymentDetail user={user} />} />
							<Route path="/events" element={<Events user={user} />} />
							<Route path="/sandbox" element={<Sandbox user={user} />} />
							<Route path="*" element={<Navigate to="/" replace />} />
						</Routes>
					</Layout>
				)}
			</Suspense>
		</BrowserRouter>
	);
}
