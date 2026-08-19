import { useEffect, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { User } from "../lib/firebase";
import { apiFetch } from "../lib/api";
import { notifyError, notifySuccess } from "../lib/notify";
import { track } from "../lib/analytics";
import { useDialog } from "../hooks/useDialog";
import SelectMenu from "./SelectMenu";

type Interest = {
	country: string;
	useCase: string;
	monthlySpend: string;
	cardPreference: string;
	walletPayImportance: string;
	updatedAt?: string;
};

const emptyInterest: Interest = {
	country: "",
	useCase: "",
	monthlySpend: "",
	cardPreference: "",
	walletPayImportance: "",
};

export default function CardInterestSheet({ user, onClose, onSaved }: {
	user: User;
	onClose: () => void;
	onSaved: () => void;
}) {
	const { t } = useTranslation();
	const dialogRef = useDialog<HTMLDivElement>(onClose);
	const [form, setForm] = useState<Interest>(emptyInterest);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const complete = Boolean(
		form.country.trim() &&
		form.useCase &&
		form.monthlySpend &&
		form.cardPreference &&
		form.walletPayImportance,
	);

	useEffect(() => {
		let active = true;
		void apiFetch<{ interest: Interest | null }>("/card/interest", { user })
			.then((data) => {
				if (active && data.interest) setForm(data.interest);
			})
			.catch(() => {})
			.finally(() => { if (active) setLoading(false); });
		return () => { active = false; };
	}, [user]);

	function set<K extends keyof Interest>(key: K, value: Interest[K]) {
		setForm((current) => ({ ...current, [key]: value }));
	}

	async function submit(event: FormEvent) {
		event.preventDefault();
		setSaving(true);
		try {
			await apiFetch("/card/interest", { user, method: "PUT", body: form });
			track("card_interest_submitted", { useCase: form.useCase, cardPreference: form.cardPreference });
			notifySuccess(t("cardInterest.saved"));
			onSaved();
			onClose();
		} catch (error) {
			notifyError(error, t("cardInterest.error"));
		} finally {
			setSaving(false);
		}
	}

	return createPortal(
		<div className="dialog-backdrop fixed inset-0 z-50 flex items-end justify-center px-4 animate-fade-in" style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }} onClick={onClose}>
			<div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="card-interest-title" tabIndex={-1} className="dialog-panel max-h-[92dvh] w-full max-w-[430px] overflow-y-auto overscroll-contain p-5 animate-sheet-up" onClick={(event) => event.stopPropagation()}>
				<div className="sheet-handle mb-4" aria-hidden="true" />
				<div className="mb-5 flex items-start justify-between gap-4">
					<div>
						<p className="meli-kicker mb-2">GatoPago Card</p>
						<h2 id="card-interest-title" className="font-display text-[24px] leading-tight">{t("cardInterest.title")}</h2>
						<p className="mt-2 text-[13px] leading-relaxed text-text-muted">{t("cardInterest.intro")}</p>
					</div>
					<button type="button" onClick={onClose} aria-label={t("common.close")} className="meli-square-action h-11 w-11 shrink-0">
						<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
					</button>
				</div>

				{loading ? <p role="status" className="py-10 text-center text-[13px] text-text-muted">{t("common.loading")}</p> : (
					<form onSubmit={submit} className="flex flex-col gap-5">
						<label className="block text-[13px] text-text-muted">
							<span className="mb-2 block">{t("cardInterest.country")}</span>
							<input required name="country" autoComplete="country-name" maxLength={80} value={form.country} onChange={(event) => set("country", event.target.value)} className="meli-field h-12 text-[15px]" placeholder={t("cardInterest.countryPlaceholder")} />
						</label>
						<SelectField label={t("cardInterest.useCase")} name="useCase" value={form.useCase} onChange={(value) => set("useCase", value)} options={["subscriptions", "online", "travel", "advertising", "daily", "other"]} t={t} />
						<SelectField label={t("cardInterest.monthlySpend")} name="monthlySpend" value={form.monthlySpend} onChange={(value) => set("monthlySpend", value)} options={["under-100", "100-500", "500-1000", "over-1000", "prefer-not"]} t={t} />
						<SelectField label={t("cardInterest.preference")} name="cardPreference" value={form.cardPreference} onChange={(value) => set("cardPreference", value)} options={["virtual", "physical", "both"]} t={t} />
						<SelectField label={t("cardInterest.walletPay")} name="walletPayImportance" value={form.walletPayImportance} onChange={(value) => set("walletPayImportance", value)} options={["essential", "important", "not-important"]} t={t} />
						<p className="text-[11px] leading-relaxed text-text-faint">{t("cardInterest.disclaimer")}</p>
						<button type="submit" disabled={saving || !complete} className="btn btn-primary btn-block">{saving ? t("cardInterest.saving") : t("cardInterest.submit")}</button>
					</form>
				)}
			</div>
		</div>,
		document.body,
	);
}

function SelectField({ label, name, value, onChange, options, t }: {
	label: string;
	name: string;
	value: string;
	onChange: (value: string) => void;
	options: string[];
	t: (key: string) => string;
}) {
	return (
		<SelectMenu
			label={label}
			name={name}
			value={value || null}
			options={options.map((option) => ({ value: option, label: t(`cardInterest.options.${option}`) }))}
			onChange={onChange}
			placeholder={t("cardInterest.choose")}
			required
		/>
	);
}
