import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { FAILURE_KIND, classifyDownloadError, classifyPnpmInstallOutput, downloadDiagnostic, errorDiagnostic, pnpmInstallDiagnostic, redactUrls } from "../scripts/installer-diagnostics.mjs";
import { verifiedDownload } from "../scripts/installer-downloads.mjs";

const CORPORATE_HOST = "registry.example.invalid";
const PINNED_BYTES = Buffer.from("pinned artifact bytes");

/** A local download source answering every request with `status` and `body`. */
async function localSource(status: number, body: Buffer) {
	const server: Server = createServer((_request, response) => {
		response.writeHead(status, { "content-length": String(body.length) });
		response.end(body);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const { port } = server.address() as { port: number };
	return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
/** A descriptor of the pinned bytes, fetched from `url` through the real download(). */
function pinnedArtifact(url: string) {
	return () => ({ name: "pnpm", version: "11.1.1", url, maxBytes: 1024, integrity: `sha256-${createHash("sha256").update(PINNED_BYTES).digest("hex")}` });
}
async function failedDownload(url: string) {
	try {
		await verifiedDownload("pnpm", { artifact: pinnedArtifact(url) });
	} catch (error) {
		return error as Error & { diagnosis?: Record<string, unknown> };
	}
	assert.fail("the download was expected to fail");
}

test("a download source answering 401, 403 or 404 is diagnosed by status, artifact and version, without its URL", async () => {
	for (const status of [401, 403, 404]) {
		const source = await localSource(status, Buffer.from("denied"));
		try {
			const error = await failedDownload(`http://127.0.0.1:${source.port}/secret-path/pnpm-11.1.1.tgz`);
			assert.equal(error.message, "Download failed");
			assert.deepEqual(error.diagnosis, { name: "pnpm", version: "11.1.1", kind: FAILURE_KIND.http, status });
			const line = errorDiagnostic(error);
			assert.match(String(line), new RegExp(`^pnpm 11\\.1\\.1: the download source answered HTTP ${status} \\(`));
			assert.doesNotMatch(String(line), /127\.0\.0\.1|secret-path|http:/);
		} finally { await source.close(); }
	}
});

test("a refused connection and a TLS handshake against a non-TLS port are told apart", async () => {
	const closed = await localSource(200, PINNED_BYTES);
	const { port } = closed;
	await closed.close();
	const refused = await failedDownload(`http://127.0.0.1:${port}/pnpm.tgz`);
	assert.equal(refused.diagnosis?.kind, FAILURE_KIND.connection);
	assert.match(String(errorDiagnostic(refused)), /could not be reached \(connection refused, reset or timed out\)/);

	const plain = await localSource(200, PINNED_BYTES);
	try {
		const handshake = await failedDownload(`https://127.0.0.1:${plain.port}/pnpm.tgz`);
		assert.equal(handshake.diagnosis?.kind, FAILURE_KIND.tls);
		assert.match(String(errorDiagnostic(handshake)), /TLS connection to the download source was rejected/);
	} finally { await plain.close(); }
});

test("altered bytes from a source are an integrity failure, distinct from size", async () => {
	const altered = await localSource(200, Buffer.from("altered artifact bytes"));
	try {
		const error = await failedDownload(`http://127.0.0.1:${altered.port}/pnpm.tgz`);
		assert.equal(error.message, "Download integrity mismatch");
		assert.equal(error.diagnosis?.kind, FAILURE_KIND.integrity);
		assert.match(String(errorDiagnostic(error)), /do not match the pinned checksum; nothing was extracted or run/);
	} finally { await altered.close(); }
	const empty = await localSource(200, Buffer.alloc(0));
	try {
		const error = await failedDownload(`http://127.0.0.1:${empty.port}/pnpm.tgz`);
		assert.equal(error.diagnosis?.kind, FAILURE_KIND.size);
	} finally { await empty.close(); }
});

test("a pinned artifact is named only by a valid name and version", () => {
	assert.equal(downloadDiagnostic({ name: "pnpm", version: "11.1.1", kind: FAILURE_KIND.http, status: 418 }), "pnpm 11.1.1: the download source answered HTTP 418");
	assert.match(downloadDiagnostic({ name: "https://evil.example/x", version: "1", kind: FAILURE_KIND.unknown }), /^a pinned artifact: /);
	assert.equal(classifyDownloadError(new Error("anything")).kind, FAILURE_KIND.unknown);
});

// pnpm's own output for the registry failures the issue reproduced, with the corporate host anonymized.
const pnpmFetch403 = `ERR_PNPM_FETCH_403  GET https://${CORPORATE_HOST}/repository/all/@aws-sdk/xml-builder/-/xml-builder-3.972.43.tgz: Forbidden - 403`;
test("pnpm registry failures are classified with the package spec, never the registry host", () => {
	assert.deepEqual(classifyPnpmInstallOutput(`Progress: resolved 12\n${pnpmFetch403}\n\nNo authorization header was set for the request.`),
		{ kind: FAILURE_KIND.http, status: 403, package: "@aws-sdk/xml-builder@3.972.43" });
	const line = pnpmInstallDiagnostic(classifyPnpmInstallOutput(pnpmFetch403));
	assert.equal(line, "the npm registry answered HTTP 403 (access denied, or the version is not served by this registry) for @aws-sdk/xml-builder@3.972.43; " +
		"the release's pinned versions are never replaced with other versions");
	assert.doesNotMatch(String(line), new RegExp(CORPORATE_HOST));

	const unauthorized = classifyPnpmInstallOutput(`ERR_PNPM_FETCH_401  GET https://user:token@${CORPORATE_HOST}/gentle-pi/-/gentle-pi-4.9.0.tgz: Unauthorized - 401`);
	assert.deepEqual(unauthorized, { kind: FAILURE_KIND.http, status: 401, package: "gentle-pi@4.9.0" });
	assert.doesNotMatch(String(pnpmInstallDiagnostic(unauthorized)), /token|user|never replaced/);

	assert.deepEqual(classifyPnpmInstallOutput("ERR_PNPM_NO_MATCHING_VERSION  No matching version found for @smithy/fetch-http-handler@5.8.1 while fetching it from https://x"),
		{ kind: FAILURE_KIND.http, status: 404, package: "@smithy/fetch-http-handler@5.8.1" });
	assert.equal(classifyPnpmInstallOutput(`ERR_PNPM_TARBALL_INTEGRITY  Got unexpected checksum for "https://${CORPORATE_HOST}/gentle-pi/-/gentle-pi-4.9.0.tgz"`)?.kind, FAILURE_KIND.integrity);
	assert.equal(classifyPnpmInstallOutput("request to https://x failed, reason: unable to get local issuer certificate (UNABLE_TO_GET_ISSUER_CERT_LOCALLY)")?.kind, FAILURE_KIND.tls);
	assert.equal(classifyPnpmInstallOutput("ERR_PNPM_META_FETCH_FAIL  GET https://x: request to https://x failed, reason: connect ETIMEDOUT")?.kind, FAILURE_KIND.connection);
	// A postinstall failure is not a registry failure: it keeps the generic last-line detail.
	assert.equal(classifyPnpmInstallOutput("node_modules/gentle-pi postinstall: Gentle AI build failed\n[ELIFECYCLE] exit 1"), null);
	assert.equal(pnpmInstallDiagnostic(null), null);
});

test("redactUrls removes every URL, including embedded credentials", () => {
	assert.equal(redactUrls(`GET https://user:token@${CORPORATE_HOST}/x.tgz: Forbidden`), "GET <url>: Forbidden");
	assert.equal(redactUrls("no url here"), "no url here");
	assert.equal(redactUrls(undefined), undefined);
});
