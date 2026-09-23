import childProcessAsync from "promisify-child-process";
import yaml from "yaml";
import dotenv from "dotenv";
import { log } from "./log";
import { DockgeServer } from "./dockge-server";
import { Stack } from "./stack";
import { envsubstYAML, RUNNING } from "../common/util-common";
import { Settings } from "./settings";

export const IMAGE_UPDATE_CHECK_INTERVAL_MS = 1000 * 60 * 60 * 24 * 7;

export interface StackImageUpdateInfo {
    updateable: boolean;
    images: Array<{
        image: string;
        hasUpdate: boolean;
    }>;
}

/**
 * Checks whether stack images have newer versions available on their registries.
 */
class CheckImageUpdates {
    private lastCheckTime = 0;
    private checking = false;
    private results: Map<string, StackImageUpdateInfo> = new Map();

    /**
     * @returns Cached image update results keyed by stack name
     */
    getResults() : Map<string, StackImageUpdateInfo> {
        return this.results;
    }

    /**
     * @returns Timestamp of the last completed check
     */
    getLastCheckTime() : number {
        return this.lastCheckTime;
    }

    /**
     * @returns Whether a check is currently in progress
     */
    isChecking() : boolean {
        return this.checking;
    }

    /**
     * @param force Skip the weekly cache and run a new check
     * @returns Whether a new check should run
     */
    shouldCheck(force = false) : boolean {
        if (force) {
            return true;
        }
        if (this.lastCheckTime === 0) {
            return true;
        }
        return Date.now() - this.lastCheckTime >= IMAGE_UPDATE_CHECK_INTERVAL_MS;
    }

    /**
     * @param stackName Stack to remove from the cache
     */
    invalidateStack(stackName : string) {
        this.results.delete(stackName);
    }

    /**
     * Check all managed stacks for image updates.
     * @param server Dockge server instance
     * @param force Skip the weekly cache and run a new check
     * @returns Cached or freshly computed results keyed by stack name
     */
    async check(server : DockgeServer, force = false) : Promise<Map<string, StackImageUpdateInfo>> {
        if (await Settings.get("checkImageUpdates") === false) {
            // Clear cached results so the UI stops showing updateable stacks
            this.results = new Map();
            this.lastCheckTime = 0;
            return this.results;
        }

        if (this.checking) {
            return this.results;
        }

        if (!this.shouldCheck(force)) {
            // Weekly cache hit: still drop non-running stacks and re-verify
            // stacks marked updateable so a recent pull clears false positives.
            await this.refreshCachedResults(server);
            return this.results;
        }

        this.checking = true;

        try {
            log.debug("image-update-checker", "Checking for image updates");
            const stackList = await Stack.getStackList(server, true);
            const newResults = new Map<string, StackImageUpdateInfo>();

            for (const [ stackName, stack ] of stackList) {
                if (!stack.isManagedByDockge) {
                    continue;
                }

                // Only check stacks that are currently running / active
                if (stack.status !== RUNNING) {
                    continue;
                }

                try {
                    newResults.set(stackName, await this.checkStack(stack));
                } catch (e) {
                    if (e instanceof Error) {
                        log.warn("image-update-checker", `Failed to check stack ${stackName}: ${e.message}`);
                    }
                    newResults.set(stackName, {
                        updateable: false,
                        images: [],
                    });
                }
            }

            // Setting may have been disabled while this check was running.
            // Do not restore results if the feature is now off.
            if (await Settings.get("checkImageUpdates") === false) {
                this.results = new Map();
                this.lastCheckTime = 0;
                return this.results;
            }

            this.results = newResults;
            this.lastCheckTime = Date.now();
        } finally {
            this.checking = false;
        }

        return this.results;
    }

    /**
     * Drop exited/inactive stacks from the cache and re-check digests for
     * stacks that are still marked updateable (e.g. after a manual pull).
     * @param server Dockge server instance
     */
    async refreshCachedResults(server : DockgeServer) {
        if (this.checking) {
            return;
        }

        this.checking = true;

        try {
            const stackList = await Stack.getStackList(server, true);
            const newResults = new Map<string, StackImageUpdateInfo>();

            for (const [ stackName, stack ] of stackList) {
                if (!stack.isManagedByDockge || stack.status !== RUNNING) {
                    continue;
                }

                const cached = this.results.get(stackName);
                if (!cached) {
                    continue;
                }

                if (!cached.updateable) {
                    newResults.set(stackName, cached);
                    continue;
                }

                try {
                    newResults.set(stackName, await this.checkStack(stack));
                } catch (e) {
                    if (e instanceof Error) {
                        log.warn("image-update-checker", `Failed to revalidate stack ${stackName}: ${e.message}`);
                    }
                    newResults.set(stackName, {
                        updateable: false,
                        images: [],
                    });
                }
            }

            this.results = newResults;
        } finally {
            this.checking = false;
        }
    }

    /**
     * Check whether any service image in a stack has an update available.
     * @param stack Stack to inspect
     */
    async checkStack(stack : Stack) : Promise<StackImageUpdateInfo> {
        const images = this.getStackImages(stack);
        const imageResults: StackImageUpdateInfo["images"] = [];
        let updateable = false;

        for (const image of images) {
            const hasUpdate = await this.hasImageUpdate(image);
            imageResults.push({
                image,
                hasUpdate,
            });

            if (hasUpdate) {
                updateable = true;
            }
        }

        return {
            updateable,
            images: imageResults,
        };
    }

    /**
     * Extract unique image references from a stack compose file.
     * @param stack Stack to inspect
     */
    getStackImages(stack : Stack) : string[] {
        const env = dotenv.parse(stack.composeENV);
        const content = envsubstYAML(stack.composeYAML, env);
        const doc = yaml.parse(content);
        const images: string[] = [];

        if (doc?.services) {
            for (const service of Object.values(doc.services) as Array<{ image?: string }>) {
                if (service?.image) {
                    images.push(service.image);
                }
            }
        }

        return [ ...new Set(images) ];
    }

    /**
     * Compare local and remote digests for a single image reference.
     * @param image Image reference from compose YAML
     */
    async hasImageUpdate(image : string) : Promise<boolean> {
        const localDigests = await this.getLocalDigests(image);
        const remoteDigest = await this.getRemoteDigest(image);

        // No registry digests locally (e.g. local-only build) or remote
        // lookup failed — treat as unknown, not updateable.
        if (localDigests.length === 0 || !remoteDigest) {
            return false;
        }

        const normalizedRemote = this.normalizeDigest(remoteDigest);
        return !localDigests.some((digest) => this.normalizeDigest(digest) === normalizedRemote);
    }

    /**
     * @param digest Docker image or manifest digest
     */
    normalizeDigest(digest : string) : string {
        return digest.replace(/^sha256:/, "");
    }

    /**
     * Local RepoDigests for an image tag. Never fall back to Image ID —
     * that is a content hash and will never match a registry manifest digest.
     * @param image Image reference from compose YAML
     */
    async getLocalDigests(image : string) : Promise<string[]> {
        try {
            const res = await childProcessAsync.spawn("docker", [
                "image", "inspect", "--format", "{{json .RepoDigests}}", image,
            ], {
                encoding: "utf-8",
            });

            const stdout = res.stdout?.toString().trim();
            if (!stdout || stdout === "null") {
                return [];
            }

            const digests = JSON.parse(stdout) as string[];
            const result: string[] = [];

            for (const entry of digests) {
                const parts = entry.split("@");
                if (parts.length === 2 && parts[1]) {
                    result.push(parts[1]);
                }
            }

            return result;
        } catch {
            return [];
        }
    }

    /**
     * @param image Image reference from compose YAML
     */
    async getRemoteDigest(image : string) : Promise<string | null> {
        try {
            const res = await childProcessAsync.spawn("docker", [
                "buildx", "imagetools", "inspect", image, "--format", "{{json .}}",
            ], {
                encoding: "utf-8",
            });

            const stdout = res.stdout?.toString().trim();
            if (stdout) {
                const data = JSON.parse(stdout);
                // Prefer the index/manifest digest — this is what RepoDigests stores after pull/push
                if (data.manifest?.digest) {
                    return data.manifest.digest;
                }
            }
        } catch {
            // buildx may be unavailable; fall back to manifest inspect
        }

        try {
            const res = await childProcessAsync.spawn("docker", [
                "manifest", "inspect", image,
            ], {
                encoding: "utf-8",
            });

            const stdout = res.stdout?.toString().trim();
            if (!stdout) {
                return null;
            }

            const data = JSON.parse(stdout);

            if (Array.isArray(data)) {
                return data[0]?.Descriptor?.digest || null;
            }

            // Manifest list / index: use the index digest from Descriptor if present,
            // otherwise we cannot reliably match RepoDigests with a platform child digest.
            if (data.manifests && Array.isArray(data.manifests)) {
                if (data.Descriptor?.digest) {
                    return data.Descriptor.digest;
                }
                // docker manifest inspect does not always expose the list digest;
                // avoid comparing platform digests (false positives).
                return null;
            }

            return data.Descriptor?.digest || null;
        } catch {
            return null;
        }
    }
}

const checkImageUpdates = new CheckImageUpdates();
export default checkImageUpdates;
