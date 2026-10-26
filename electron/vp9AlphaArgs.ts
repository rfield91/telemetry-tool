/** Shared VP9+alpha output flags tuned for 1080p60 overlay exports. */
export function vp9AlphaOutputArgs(outputPath: string): string[] {
  return [
    '-an',
    '-c:v',
    'libvpx-vp9',
    '-pix_fmt',
    'yuva420p',
    '-auto-alt-ref',
    '0',
    '-row-mt',
    '1',
    '-cpu-used',
    '6',
    '-deadline',
    'good',
    '-threads',
    '0',
    '-tile-columns',
    '2',
    '-frame-parallel',
    '1',
    '-metadata:s:v:0',
    'alpha_mode=1',
    '-y',
    outputPath,
  ]
}
