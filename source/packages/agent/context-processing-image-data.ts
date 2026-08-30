import { getBlobId } from "../agent-kv/blob-store.js";
import type { Context } from "../context/core.js";
import {
  SelectedImage,
  type SelectedImage as SelectedImageValue,
} from "../proto/generated/agent/v1/selected_context_pb.js";

export interface SelectedImageBlobStore<StoreContext = Context> {
  getBlob(ctx: StoreContext, blobId: Uint8Array): Promise<Uint8Array | undefined>;
  setBlob(ctx: StoreContext, blobId: Uint8Array, data: Uint8Array): Promise<void>;
  setBlobLocallyOnly(ctx: StoreContext, blobId: Uint8Array, data: Uint8Array): Promise<void>;
}

export interface HydrateSelectedImageDataArgs<StoreContext = Context> {
  readonly ctx: StoreContext;
  readonly blobStore: SelectedImageBlobStore<StoreContext>;
  readonly selectedImage: SelectedImageValue;
}

export interface HydratedSelectedImageData {
  readonly selectedImage: SelectedImageValue | undefined;
  readonly imageData: Uint8Array | undefined;
}

// Extracted from ../packages/agent/dist/context-processing.js as the exact
// selected-image data/blob hydration prerequisite. MIME sniffing, dimensions,
// image codecs, file spill, and the parent processSelectedContext dispatcher
// remain absent by design.
export async function hydrateSelectedImageData<StoreContext = Context>({
  ctx,
  blobStore,
  selectedImage,
}: HydrateSelectedImageDataArgs<StoreContext>): Promise<HydratedSelectedImageData> {
  let imageData: Uint8Array | undefined;
  let processedSelectedImage: SelectedImageValue | undefined;
  if (selectedImage.dataOrBlobId?.case === "data") {
    imageData = selectedImage.dataOrBlobId.value;
    const imageBlobId = await getBlobId(imageData);
    await blobStore.setBlob(ctx, imageBlobId, imageData);
    processedSelectedImage = new SelectedImage({
      ...selectedImage,
      dataOrBlobId: {
        case: "blobId",
        value: new Uint8Array(imageBlobId),
      },
    });
  } else if (selectedImage.dataOrBlobId?.case === "blobId") {
    const imageBlobId = selectedImage.dataOrBlobId.value;
    imageData = await blobStore.getBlob(ctx, imageBlobId);
    if (!imageData) {
      throw new Error("Image not found");
    }
    processedSelectedImage = selectedImage;
  } else if (selectedImage.dataOrBlobId?.case === "blobIdWithData") {
    const blobIdWithData = selectedImage.dataOrBlobId.value;
    imageData = blobIdWithData.data;
    await blobStore.setBlobLocallyOnly(ctx, blobIdWithData.blobId, imageData);
    processedSelectedImage = new SelectedImage({
      ...selectedImage,
      dataOrBlobId: {
        case: "blobId",
        value: new Uint8Array(blobIdWithData.blobId),
      },
    });
  } else if (selectedImage.dataOrBlobId?.case === "promptUploadRef") {
    throw new Error("Image still references an unresolved prompt upload.");
  }
  return { selectedImage: processedSelectedImage, imageData };
}
