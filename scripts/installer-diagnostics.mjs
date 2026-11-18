// Classified, sanitized diagnostics for the installer's network stages: the
// verified runtime downloads (install-runtime, the bootstraps) and the release
// install pnpm runs from its lockfile (install-version). A diagnostic names the
// failure kind, an HTTP status and the package or artifact with its version, and
// never a URL, host, header, token or path: those can carry a corporate registry
// or credentials, and the line reaches the wizard's browser view and terminal.

/** Failure kinds, from the transport up to the bytes and the executable. */
export const FAILURE_KIND = Object.freeze({
	connection: "connection",
	tls: "tls",
	http: "http",
	redirect: "redirect",
	encoding: "encoding",
	size: "size",
	integrity: "integrity",
	execution: "execution",
	unknown: "unknown",
});

// undici and Node network error codes for a connection that never answered.
const CONNECTION_CODES = new Set(["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_CLOSED",
	"ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "ERR_SOCKET_CONNECTION_TIMEOUT"]);
// OpenSSL / Node certificate and handshake error codes.
const TLS_CODE = /^(?:CERT_|UNABLE_TO_|SELF_SIGNED_CERT|DEPTH_ZERO_SELF_SIGNED_CERT|ERR_TLS_|ERR_SSL_|HOSTNAME_MISMATCH|ERR_OSSL_)/;
const TIMEOUT_NAMES = new Set(["TimeoutError", "AbortError"]);
/** How deep a cause chain is followed; fetch nests the socket error twice. */
const CAUSE_DEPTH_LIMIT = 6;

/** What an HTTP status most often means for a registry or download host. */
const HTTP_MEANING = Object.freeze({
	401: "authentication required or rejected",
	403: "access denied, or the version is not served by this registry",
	404: "not found on this registry",
	407: "proxy authentication required",
	429: "rate limited",
});
const SEMVER_TEXT = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
// A package name as npm allows it (optionally scoped), never anything with a slash beyond the scope.
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const DIAGNOSTIC_LIMIT = 240;

function causes(error) {
	const chain = [];
	for (let current = error, depth = 0; current && depth < CAUSE_DEPTH_LIMIT; current = current.cause, depth += 1) chain.push(current);
	return chain;
}

/** The kind of a download failure and, for an HTTP answer, its status. Reads
 * only error codes, names, fixed messages and `status`, never the URL.
 */
export function classifyDownloadError(error) {
	for (const entry of causes(error)) {
		if (Number.isInteger(entry?.status)) return { kind: FAILURE_KIND.http, status: entry.status };
	}
	for (const entry of causes(error)) {
		const code = typeof entry?.code === "string" ? entry.code : "";
		if (TLS_CODE.test(code)) return { kind: FAILURE_KIND.tls };
		if (CONNECTION_CODES.has(code) || TIMEOUT_NAMES.has(entry?.name)) return { kind: FAILURE_KIND.connection };
	}
	for (const entry of causes(error)) {
		const message = String(entry?.message ?? "");
		if (/^Download redirect rejected$|redirect/i.test(message)) return { kind: FAILURE_KIND.redirect };
		if (/^Download was encoded /.test(message)) return { kind: FAILURE_KIND.encoding };
		if (/^Download (?:size rejected|truncated)$/.test(message)) return { kind: FAILURE_KIND.size };
		if (/^Download integrity mismatch$/.test(message)) return { kind: FAILURE_KIND.integrity };
	}
	return { kind: FAILURE_KIND.unknown };
}

function httpText(status) {
	return Object.hasOwn(HTTP_MEANING, status) ? `HTTP ${status} (${HTTP_MEANING[status]})` : `HTTP ${status}`;
}

const DOWNLOAD_TEXT = Object.freeze({
	[FAILURE_KIND.connection]: "the download source could not be reached (connection refused, reset or timed out)",
	[FAILURE_KIND.tls]: "the TLS connection to the download source was rejected (certificate or handshake)",
	[FAILURE_KIND.redirect]: "the download source redirected to a location that is not allowed",
	[FAILURE_KIND.encoding]: "the download source sent an encoded body although identity was requested",
	[FAILURE_KIND.size]: "the download was empty, truncated or larger than its pinned bound",
	[FAILURE_KIND.integrity]: "the downloaded bytes do not match the pinned checksum; nothing was extracted or run",
	[FAILURE_KIND.execution]: "the verified download did not run or did not report its pinned version",
	[FAILURE_KIND.unknown]: "the download failed for an unclassified reason",
});

/** One line for a failed verified download of a pinned artifact. */
export function downloadDiagnostic({ name, version, kind, status }) {
	const label = PACKAGE_NAME.test(String(name)) && SEMVER_TEXT.test(String(version)) ? `${name} ${version}` : "a pinned artifact";
	const reason = kind === FAILURE_KIND.http && Number.isInteger(status) ? `the download source answered ${httpText(status)}` : DOWNLOAD_TEXT[kind] ?? DOWNLOAD_TEXT[FAILURE_KIND.unknown];
	return `${label}: ${reason}`;
}

/** The diagnosis a verified-download error carries, as one line, or null. */
export function errorDiagnostic(error) {
	for (const entry of causes(error)) {
		const diagnosis = entry?.diagnosis;
		if (diagnosis && typeof diagnosis === "object") return downloadDiagnostic(diagnosis);
	}
	return null;
}

/** `name@version` from an npm tarball URL path (`/<name>/-/<file>-<version>.tgz`),
 * without the host or any path prefix a mirror adds. Null when it does not fit.
 */
function tarballPackage(url) {
	let pathname;
	// Punctuation pnpm prints right after the URL (`...tgz: Forbidden`) is not part of it.
	try { pathname = decodeURIComponent(new URL(String(url).replace(/[:,;.)"'`]+$/, "")).pathname); } catch { return null; }
	const match = /\/((?:@[^/]+\/)?[^/@]+)\/-\/[^/]+-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.tgz$/.exec(pathname);
	return match && PACKAGE_NAME.test(match[1]) ? `${match[1]}@${match[2]}` : null;
}
/** `name@version` from pnpm's registry metadata messages, or null. */
function specPackage(text) {
	const match = /(?:^|[\s"'`(])((?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(text);
	return match ? `${match[1]}@${match[2]}` : null;
}

/** The registry failure pnpm reported for an install, classified, or null when
 * the output shows none (a postinstall or verification failure stays with the
 * generic last-line detail). Reads only pnpm's error codes, the HTTP status and
 * the package spec; the URL's host and any credentials are discarded.
 */
export function classifyPnpmInstallOutput(output) {
	const text = String(output ?? "");
	const fetch = /ERR_PNPM_FETCH_(\d{3})\b[^\n]*?\b(?:GET|HEAD)\s+(\S+)/.exec(text);
	if (fetch) return { kind: FAILURE_KIND.http, status: Number(fetch[1]), package: tarballPackage(fetch[2]) };
	const status = /ERR_PNPM_FETCH_(\d{3})\b/.exec(text);
	if (status) return { kind: FAILURE_KIND.http, status: Number(status[1]), package: specPackage(text) };
	const missing = /ERR_PNPM_NO_MATCHING_VERSION\b[^\n]*/.exec(text);
	if (missing) return { kind: FAILURE_KIND.http, status: 404, package: specPackage(missing[0]) };
	if (/ERR_PNPM_(?:TARBALL_INTEGRITY|BAD_TARBALL_SIZE)\b|\bEINTEGRITY\b/.test(text)) {
		const line = /(?:ERR_PNPM_TARBALL_INTEGRITY|ERR_PNPM_BAD_TARBALL_SIZE|EINTEGRITY)[^\n]*/.exec(text)?.[0] ?? "";
		return { kind: FAILURE_KIND.integrity, package: tarballPackage(/https?:\/\/\S+/.exec(line)?.[0] ?? "") ?? specPackage(line) };
	}
	const code = /\b(UNABLE_TO_[A-Z_]+|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|CERT_[A-Z_]+|ERR_TLS_[A-Z_]+|ERR_SSL_[A-Z_]+)\b/.exec(text)?.[1];
	if (code) return { kind: FAILURE_KIND.tls, package: null };
	if (/\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|ERR_PNPM_META_FETCH_FAIL)\b/.test(text)) {
		return { kind: FAILURE_KIND.connection, package: null };
	}
	return null;
}

const INSTALL_TEXT = Object.freeze({
	[FAILURE_KIND.connection]: "the npm registry could not be reached (connection refused, reset or timed out)",
	[FAILURE_KIND.tls]: "the TLS connection to the npm registry was rejected (certificate or handshake); check the registry's CA settings (cafile) in your npm configuration",
	[FAILURE_KIND.integrity]: "a downloaded package does not match the integrity the release lockfile pins",
});

/** One line for a classified release-install failure. The release's exact
 * versions are never substituted: the line says so when a version is missing.
 */
export function pnpmInstallDiagnostic(classified) {
	if (!classified) return null;
	const subject = classified.package ? ` for ${classified.package}` : "";
	if (classified.kind === FAILURE_KIND.http) {
		const pinned = [403, 404].includes(classified.status) ? "; the release's pinned versions are never replaced with other versions" : "";
		return truncate(`the npm registry answered ${httpText(classified.status)}${subject}${pinned}`);
	}
	return truncate(`${INSTALL_TEXT[classified.kind] ?? "the release install failed"}${subject}`);
}

function truncate(text) {
	return Array.from(text).slice(0, DIAGNOSTIC_LIMIT).join("");
}

/** `text` with every URL replaced by `<url>`: a registry address can name a
 * corporate host or carry credentials (`https://user:token@host/`).
 */
export function redactUrls(text) {
	return typeof text === "string" ? text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>]*[^\s"'`<>:,;.)]/gi, "<url>") : text;
}
