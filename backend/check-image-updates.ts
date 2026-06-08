import childProcessAsync from "promisify-child-process";
import yaml from "yaml";
import dotenv from "dotenv";
import { log } from "./log";
import { DockgeServer } from "./dockge-server";
import { Stack } from "./stack";
import { envsubstYAML } from "../common/util-common";

export const IMAGE_UPDATE_CHECK_INTERVAL_MS = 1000 * 60 * 60 * 24 * 7;

export interface StackImageUpdateInfo {
    updateable: boolean;
    images: Array<{
        image: string;
        hasUpdate: boolean;
    }>;
}

class CheckImageUpdates {
    private lastCheckTime = 0;
    private checking = false;
    private results: Map<string, StackImageUpdateInfo> = new Map();

    getResults(): Map<string, StackImageUpdateInfo> {
        return this.results;
    }

    getLastCheckTime(): number {
        return this.lastCheckTime;
    }

    isChecking(): boolean {
        return this.checking;
    }

    shouldCheck(force = false): boolean {
        if (force) {
            return true;
        }
        if (this.lastCheckTime === 0) {
            return true;
        }
        return Date.now() - this.lastCheckTime >= IMAGE_UPDATE_CHECK_INTERVAL_MS;
    }

    invalidateStack(stackName: string) {
        this.results.delete(stackName);
    }

    async check(server: DockgeServer, force = false): Promise<Map<string, StackImageUpdateInfo>> {
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

            this.results = newResults;
            this.lastCheckTime = Date.now();
        } finally {
            this.checking = false;
        }

        return this.results;
    }

    async checkStack(stack: Stack): Promise<StackImageUpdateInfo> {
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

    getStackImages(stack: Stack): string[] {
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

    async hasImageUpdate(image: string): Promise<boolean> {
        const localDigest = await this.getLocalDigest(image);
        const remoteDigest = await this.getRemoteDigest(image);

        if (!localDigest || !remoteDigest) {
            return false;
        }

        return this.normalizeDigest(localDigest) !== this.normalizeDigest(remoteDigest);
    }

    normalizeDigest(digest: string): string {
        return digest.replace(/^sha256:/, "");
    }

    async getLocalDigest(image: string): Promise<string | null> {
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

    async getRemoteDigest(image: string): Promise<string | null> {
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
