export default function Logo({ className = "w-10" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 128 128" shapeRendering="crispEdges" role="img" aria-label="GatoPago">
			<path fill="#050507" d="M16 28V12h28v8h8v8h24v-8h8v-8h28v16h8v60h-8v12h-8v8h-12v8H36v-8H24v-8h-8V88H8V28z" />
			<path fill="#F85239" d="M20 28V16h20v8h8v8h32v-8h8v-8h20v12h8v56h-8v12h-8v8h-8v8H36v-8h-8v-8h-8V84h-8V28z" />
			<path fill="#CF3433" d="M24 24h12v8h8v12H32v-8h-8zm68 0h12v12h-8v8H84V32h8zM52 32h8v16h-8zm16 0h8v16h-8zM56 78h16v8H56z" />
			<path fill="#050507" d="M36 60h12v16H36zm44 0h12v16H80zM8 68h16v4H8zm0 12h20v4H8zm96-12h16v4h-16zm-4 12h20v4h-20zM52 84h8v8h8v-8h8v12h-8v4h-8v-4h-8z" />
		</svg>
	);
}
