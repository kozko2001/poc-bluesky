# Bluesky Firehose Aggregator on Kubernetes

This folder contains a minimal Kustomize configuration for running the Bluesky like/repost aggregator on Kubernetes with its LevelDB state stored on a persistent volume.

## Manifests

- `namespace.yaml` – isolates the workload in the `bluesky-firehose` namespace.
- `pvc.yaml` – a `PersistentVolumeClaim` (`ReadWriteOnce`, 10 GiB) mounted at `/data` inside the pod. Feel free to tweak the storage request or add a `storageClassName` to match your cluster.
- `deployment.yaml` – single-replica deployment of the Docker image (replace the `image:` reference with your own registry tag). The container mounts the PVC at `/data`, where the aggregator keeps its LevelDB (`STATE_FILE=/data/aggregator-db`).
- `kustomization.yaml` – ties everything together and adds basic labels. `namespace` is set to `bluesky-firehose`, so you can apply the manifests with a single command.

## Usage

```bash
# Adjust the image reference in deployment.yaml first.

kubectl apply -k k8s/
```

To delete everything:

```bash
kubectl delete -k k8s/
```

> **Tip:** If your cluster uses a non-default storage class, add `storageClassName` under `spec` in `pvc.yaml`. You can also raise the `resources` limits/requests in `deployment.yaml` if you expect heavier firehose traffic.
