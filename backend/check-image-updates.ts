import childProcessAsync from "promisify-child-process";
import yaml from "yaml";
import dotenv from "dotenv";
import { log } from "./log";
import { DockgeServer } from "./dockge-server";
import { Stack } from "./stack";
import { envsubstYAML } from "../common/util-common";
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
        const localDigest = await this.getLocalDigest(image);
        const remoteDigest = await this.getRemoteDigest(image);

        if (!localDigest || !remoteDigest) {
            return false;
        }

        return this.normalizeDigest(localDigest) !== this.normalizeDigest(remoteDigest);
    }

    /**
     * @param digest Docker image or manifest digest
     */
    normalizeDigest(digest : string) : string {
        return digest.replace(/^sha256:/, "");
    }

    /**
     * @param image Image reference from compose YAML
     */
    async getLocalDigest(image : string) : Promise<string | null> {
        try {
            const res = await childProcessAsync.spawn("docker", [
                "image", "inspect", "--format", "{{json .RepoDigests}}", image,
            ], {
                encoding: "utf-8",
            });

            const stdout = res.stdout?.toString().trim();
            if (!stdout || stdout === "null") {
                return null;
            }

            const digests = JSON.parse(stdout) as string[];
            if (digests.length > 0) {
                const parts = digests[0].split("@");
                if (parts.length === 2) {
                    return parts[1];
                }
            }

            const idRes = await childProcessAsync.spawn("docker", [
                "image", "inspect", "--format", "{{.Id}}", image,
            ], {
                encoding: "utf-8",
            });

            const id = idRes.stdout?.toString().trim();
            return id || null;
        } catch {
            return null;
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
                return data[0]?.Descriptor?.digest || data[0]?.Config?.digest || null;
            }

            if (data.manifests && Array.isArray(data.manifests)) {
                const hostArch = process.arch === "arm64" ? "arm64" : process.arch === "arm" ? "arm" : "amd64";
                const platformManifest = data.manifests.find((manifest: { platform?: { os?: string, architecture?: string } }) =>
                    manifest.platform?.os === "linux" && manifest.platform?.architecture === hostArch
                );
                return platformManifest?.digest || data.manifests[0]?.digest || null;
            }

            return data.Descriptor?.digest || data.config?.digest || null;
        } catch {
            return null;
        }
    }
}

const checkImageUpdates = new CheckImageUpdates();
export default checkImageUpdates;
