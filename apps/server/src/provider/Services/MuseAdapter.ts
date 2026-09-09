/**
 * MuseAdapter — shape type for the Muse Code provider adapter.
 *
 * The driver model ({@link ../Drivers/MuseDriver}) bundles one adapter per
 * instance as a captured closure, so this module only retains the shape
 * interface as a naming anchor for the driver bundle.
 *
 * @module MuseAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * MuseAdapterShape — per-instance Muse Code adapter contract.
 */
export interface MuseAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
