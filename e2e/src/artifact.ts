const EM_BPF = 247;

/**
 * The SBPF version of a built program, from its ELF header: `e_flags` holds it for the BPF machine.
 * Undefined when the bytes are not a little-endian ELF64 file for that machine. Devnet and mainnet
 * keep deploying v3 programs; the local network accepts older ones only with a feature gate off
 * (spec §12.5), so this check catches what the local network would let through.
 */
export function sbpfVersion(bytes: Uint8Array): number | undefined {
  if (bytes.length < 52) return undefined;
  const isElf64 = bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46 && bytes[4] === 2 && bytes[5] === 1;
  if (!isElf64) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint16(18, true) === EM_BPF ? view.getUint32(48, true) : undefined;
}
