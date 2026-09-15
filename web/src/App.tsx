import { FormEvent, useEffect, useState } from "react";
import { getAuthToken, useConnectWithOtp, useDynamicContext, useIsLoggedIn } from "@dynamic-labs/sdk-react-core";
import { isEthereumWallet } from "@dynamic-labs/ethereum";

type Props = { apiUrl: string };
type Transaction = { to: `0x${string}`; data: `0x${string}`; value: string; chainId: number };
type Activity = {
  id: string; shareCode: string; organizerName: string; title: string; location: string;
  startsAt: string; fundingDeadline: string; capacity: number; contribution: string;
  currency: "EUR"; recipientName: string; description?: string; confirmedCount: number;
  status: "collecting" | "ready" | "funded" | "failed" | "cancelled";
};

const money = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
const date = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

async function request(apiUrl: string, path: string, body?: unknown, authenticated = false) {
  const response = await fetch(`${apiUrl}${path}`, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...(authenticated ? { Authorization: `Bearer ${getAuthToken()}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Une erreur est survenue.");
  return data;
}
function sharedCode() { return new URLSearchParams(window.location.search).get("activity") ?? new URLSearchParams(window.location.hash.slice(1)).get("activity"); }

export default function App({ apiUrl }: Props) {
  const loggedIn = useIsLoggedIn();
  const { handleLogOut } = useDynamicContext();
  const [route, setRoute] = useState<"home" | "create" | "activity">(sharedCode() ? "activity" : "home");
  const [activity, setActivity] = useState<Activity | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(Boolean(sharedCode()));
  const [error, setError] = useState("");
  useEffect(() => { const sync = () => setRoute(sharedCode() ? "activity" : window.location.hash === "#create" ? "create" : "home"); window.addEventListener("hashchange", sync); return () => window.removeEventListener("hashchange", sync); }, []);
  useEffect(() => { const code = sharedCode(); if (!code) return; setLoading(true); setError(""); void request(apiUrl, `/activities/shared/${code}`).then(data => setActivity(data.activity)).catch(reason => setError(reason.message)).finally(() => setLoading(false)); }, [apiUrl, route]);
  useEffect(() => { if (!loggedIn || route !== "home") return; void request(apiUrl, "/activities", undefined, true).then(data => setActivities(data.activities)).catch(() => undefined); }, [apiUrl, loggedIn, route]);
  if (route === "activity") return <ActivityPage apiUrl={apiUrl} activity={activity} loading={loading} error={error} loggedIn={loggedIn} onRefresh={() => { const code = sharedCode(); if (code) void request(apiUrl, `/activities/shared/${code}`).then(data => setActivity(data.activity)); }} />;
  if (route === "create") return loggedIn ? <CreateActivity apiUrl={apiUrl} onCreated={value => { setActivity(value); window.location.hash = `activity=${value.shareCode}`; }} /> : <SignIn onBack={() => { window.location.hash = ""; }} />;
  return <main className="cmi-shell"><header className="cmi-topbar"><Brand /><div>{loggedIn ? <button className="link-button" onClick={() => void handleLogOut()}>Se déconnecter</button> : <span className="whatsapp-first">Pensé pour WhatsApp</span>}</div></header><section className="home-hero"><span className="whatsapp-pill">● WhatsApp first</span><h1>Ton groupe est partant.<br />Que chacun confirme sa place.</h1><p>Crée l’activité, partage-la dans le groupe et laisse Count Me In gérer les paiements. Si le groupe ne se complète pas, chacun récupère son argent.</p><button className="primary" onClick={() => { window.location.hash = "create"; }}>Créer une activité</button></section>{loggedIn && activities.length > 0 && <section className="activity-list"><div className="section-title"><span>Mes activités</span><b>{activities.length}</b></div>{activities.map(item => <button key={item.id} onClick={() => { window.location.hash = `activity=${item.shareCode}`; }}><div><strong>{item.title}</strong><span>{date.format(new Date(item.startsAt))} · {item.location}</span></div><b>{item.confirmedCount}/{item.capacity}</b></button>)}</section>}<section className="three-steps"><article><b>1</b><span>Crée l’activité</span></article><article><b>2</b><span>Partage sur WhatsApp</span></article><article><b>3</b><span>Chacun paie sa place</span></article></section></main>;
}

function Brand() { return <a className="cmi-brand" href="#"><span>✓</span> count me in</a>; }

function CreateActivity({ apiUrl, onCreated }: { apiUrl: string; onCreated: (activity: Activity) => void }) {
  const { primaryWallet } = useDynamicContext();
  const tomorrow = new Date(Date.now() + 2 * 86400000); tomorrow.setMinutes(0, 0, 0); const deadline = new Date(tomorrow.getTime() - 86400000);
  const local = (value: Date) => new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const [form, setForm] = useState({ title: "", location: "", startsAt: local(tomorrow), fundingDeadline: local(deadline), capacity: 10, contribution: "12", recipientName: "", description: "" });
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const total = Number(form.contribution || 0) * form.capacity;
  const update = (key: string, value: string | number) => setForm(current => ({ ...current, [key]: value }));
  async function send(transaction: Transaction) {
    if (!primaryWallet || !isEthereumWallet(primaryWallet)) throw new Error("Ton moyen de paiement est en cours de préparation.");
    await primaryWallet.switchNetwork(transaction.chainId);
    const wallet = await primaryWallet.getWalletClient(String(transaction.chainId));
    return wallet.sendTransaction({ to: transaction.to, data: transaction.data, value: BigInt(transaction.value), account: wallet.account, chain: wallet.chain });
  }
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); setError(""); try {
    if (!primaryWallet?.address) throw new Error("Connecte-toi pour créer l’activité.");
    const data = await request(apiUrl, "/activities", { ...form, walletAddress: primaryWallet.address, recipientAddress: primaryWallet.address, contribution: form.contribution.replace(",", "."), startsAt: new Date(form.startsAt).toISOString(), fundingDeadline: new Date(form.fundingDeadline).toISOString() }, true);
    const hash = await send(data.transactions[0]);
    const deployed = await request(apiUrl, `/activities/${data.activity.id}/deployment`, { hash }, true);
    onCreated(deployed.activity);
  } catch (reason) { setError(reason instanceof Error ? reason.message : "Impossible de créer l’activité."); } finally { setBusy(false); } }
  return <main className="cmi-shell create-shell"><header className="cmi-topbar"><button className="back" onClick={() => { window.location.hash = ""; }}>←</button><Brand /><span /></header><form className="create-form" onSubmit={submit}><div className="form-heading"><span>Nouvelle activité</span><h1>On fait quoi ?</h1></div><label>Nom de l’activité<input autoFocus value={form.title} onChange={e => update("title", e.target.value)} placeholder="Foot du jeudi" required maxLength={80} /></label><label>Lieu<input value={form.location} onChange={e => update("location", e.target.value)} placeholder="UrbanSoccer Porte d’Ivry" required /></label><div className="field-grid"><label>Date et heure<input type="datetime-local" value={form.startsAt} onChange={e => update("startsAt", e.target.value)} required /></label><label>Répondre avant<input type="datetime-local" value={form.fundingDeadline} onChange={e => update("fundingDeadline", e.target.value)} required /></label></div><div className="field-grid"><label>Nombre de places<input type="number" min="2" max="100" value={form.capacity} onChange={e => update("capacity", Number(e.target.value))} required /></label><label>Prix par personne<div className="money-input"><input inputMode="decimal" value={form.contribution} onChange={e => update("contribution", e.target.value)} required pattern="[0-9]+([.,][0-9]{1,2})?" /><span>€</span></div></label></div><label>Qui reçoit le paiement ?<input value={form.recipientName} onChange={e => update("recipientName", e.target.value)} placeholder="Nom du terrain ou du prestataire" required /></label><label>Un mot pour le groupe <em>facultatif</em><textarea value={form.description} onChange={e => update("description", e.target.value)} placeholder="Rendez-vous 15 minutes avant 👟" maxLength={280} /></label><aside className="terms-preview"><div><span>Total si le groupe est complet</span><strong>{money.format(total)}</strong></div><p>Le paiement partira à {form.recipientName || "la personne indiquée"} uniquement si les {form.capacity} places sont prises.</p></aside>{error && <p className="form-error" role="alert">{error}</p>}<button className="primary sticky-action" disabled={busy}>{busy ? "Création…" : "Créer et partager"}</button></form></main>;
}

function ActivityPage({ apiUrl, activity, loading, error, loggedIn, onRefresh }: { apiUrl: string; activity: Activity | null; loading: boolean; error: string; loggedIn: boolean; onRefresh: () => void }) {
  const { primaryWallet } = useDynamicContext(); const [busy, setBusy] = useState(false); const [paymentError, setPaymentError] = useState("");
  const shareUrl = activity ? `${window.location.origin}${window.location.pathname}?activity=${activity.shareCode}` : window.location.href; const text = activity ? `${activity.title} — ${date.format(new Date(activity.startsAt))}, ${money.format(Number(activity.contribution))} par personne. Tu viens ?` : "";
  async function share() { if (navigator.share) { try { await navigator.share({ title: activity?.title, text, url: shareUrl }); return; } catch { return; } } window.open(`https://wa.me/?text=${encodeURIComponent(`${text}\n${shareUrl}`)}`, "_blank", "noopener,noreferrer"); }
  async function reserve() { try { setBusy(true); setPaymentError(""); if (!activity || !primaryWallet?.address || !isEthereumWallet(primaryWallet)) { window.location.hash = "create"; return; }
    const prepared = await request(apiUrl, `/activities/${activity.id}/join/prepare`, { walletAddress: primaryWallet.address }, true);
    for (const transaction of prepared.transactions as Transaction[]) { await primaryWallet.switchNetwork(transaction.chainId); const wallet = await primaryWallet.getWalletClient(String(transaction.chainId)); const hash = await wallet.sendTransaction({ to: transaction.to, data: transaction.data, value: BigInt(transaction.value), account: wallet.account, chain: wallet.chain }); if (transaction === prepared.transactions[prepared.transactions.length - 1]) await request(apiUrl, `/activities/${activity.id}/join/confirm`, { hash }, true); }
    onRefresh();
  } catch (reason) { setPaymentError(reason instanceof Error ? reason.message : "Le paiement n’a pas abouti."); } finally { setBusy(false); } }
  if (loading) return <main className="center-state"><div className="spinner" /><p>Ouverture de l’invitation…</p></main>;
  if (error || !activity) return <main className="center-state"><Brand /><h1>Cette invitation n’est plus disponible.</h1><a href="#">Retour à l’accueil</a></main>;
  const percent = Math.round(activity.confirmedCount / activity.capacity * 100);
  return <main className="invite-page"><header className="invite-top"><Brand /><button className="share-icon" onClick={() => void share()} aria-label="Partager">↗</button></header><section className="invite-card"><span className="organizer">Invitation de {activity.organizerName}</span><h1>{activity.title}</h1>{activity.description && <p className="description">{activity.description}</p>}<div className="event-facts"><div><span>Quand</span><strong>{date.format(new Date(activity.startsAt))}</strong></div><div><span>Où</span><strong>{activity.location}</strong></div><div><span>Ta place</span><strong>{money.format(Number(activity.contribution))}</strong></div></div><div className="progress"><div><span>{activity.confirmedCount} personnes confirmées</span><b>{activity.capacity - activity.confirmedCount} places restantes</b></div><i><span style={{ width: `${percent}%` }} /></i></div><div className="promise"><span>✓</span><p><strong>Tu ne prends aucun risque.</strong><br />{activity.recipientName} est payé seulement si le groupe est complet. Sinon, ton argent est rendu.</p></div>{paymentError && <p className="form-error">{paymentError}</p>}<button className="primary reserve" disabled={busy} onClick={() => void reserve()}>{busy ? "Confirmation…" : loggedIn ? `Réserver ma place · ${money.format(Number(activity.contribution))}` : "Se connecter pour réserver"}</button><button className="whatsapp-share" onClick={() => void share()}>Partager dans le groupe WhatsApp</button><small>Paiement sécurisé · Réponse avant le {date.format(new Date(activity.fundingDeadline))}</small></section></main>;
}

function SignIn({ onBack }: { onBack: () => void }) {
  const { connectWithEmail, verifyOneTimePassword } = useConnectWithOtp(); const [email, setEmail] = useState(""); const [code, setCode] = useState(""); const [sent, setSent] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function submit(event: FormEvent) { event.preventDefault(); setBusy(true); setError(""); try { if (!sent) { await connectWithEmail(email); setSent(true); } else await verifyOneTimePassword(code); } catch { setError("Impossible de continuer. Vérifie les informations et réessaie."); } finally { setBusy(false); } }
  return <main className="signin-page"><button className="back" onClick={onBack}>←</button><section><Brand /><span className="whatsapp-pill">30 secondes</span><h1>{sent ? "Entre le code reçu" : "Avant de créer ton activité"}</h1><p>{sent ? `Nous avons envoyé un code à ${email}.` : "Indique ton email. Aucun mot de passe à retenir."}</p><form onSubmit={submit}>{!sent ? <input autoFocus type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="ton@email.com" required /> : <input autoFocus inputMode="numeric" value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ""))} placeholder="000000" maxLength={6} required />}<button className="primary" disabled={busy}>{busy ? "Un instant…" : sent ? "Continuer" : "Recevoir mon code"}</button></form>{error && <p className="form-error">{error}</p>}</section></main>;
}
