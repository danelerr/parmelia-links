// Differentiated API-error state: says the load failed (instead of a misleading
// empty state) and lets the user re-trigger the fetch.
export default function ErrorState({ message, onRetry }: { message?: string; onRetry: () => void }) {
	return (
		<div className="card px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-3">
			<p className="text-[14px] text-text-muted flex-1">
				{message || "No se pudieron cargar los datos. Intenta de nuevo."}
			</p>
			<button onClick={onRetry} className="btn btn-ghost btn-sm shrink-0 self-start sm:self-auto">
				Reintentar
			</button>
		</div>
	);
}
