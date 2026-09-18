"""
A small glTF 2.0 binary writer — enough for a massing model.

  Geometry is gathered per material into one mesh each, so the file has a handful of draw calls
  however many parts went in. Every position is in metres: x east, y up, z south, the same frame
  the world uses, so what is written here is what the tape measure reads there.

  The root node carries `extras.walk`: the floors a body can stand on and the walls it cannot pass,
  as plan rings in model metres. The world reads that and nothing else about the interior — the
  modeller says what is walkable, the engine does not guess it from triangles.
"""
import json
import math
import struct

import numpy as np


class Material:
    def __init__(self, name, rgb, alpha=1.0, rough=0.85, metal=0.0, double=False):
        self.name, self.rgb, self.alpha, self.rough, self.metal, self.double = name, rgb, alpha, rough, metal, double

    def gltf(self):
        m = {
            'name': self.name,
            'pbrMetallicRoughness': {'baseColorFactor': [*self.rgb, self.alpha], 'metallicFactor': self.metal, 'roughnessFactor': self.rough},
            'doubleSided': self.double
        }
        if self.alpha < 1: m['alphaMode'] = 'BLEND'
        return m


class Model:
    def __init__(self, name):
        self.name = name
        self.parts = {}      # material -> [positions, normals, indices]
        self.walk = {'floors': [], 'solids': []}

    def part(self, mat):
        if mat not in self.parts: self.parts[mat] = [[], [], []]
        return self.parts[mat]

    # ---- primitives --------------------------------------------------------------------------

    def tris(self, mat, pos, nrm, idx):
        """append vertex arrays (N,3) and an index list to a material's mesh"""
        P, N, I = self.part(mat)
        base = len(P)
        P.extend(map(tuple, pos)); N.extend(map(tuple, nrm)); I.extend(int(i) + base for i in idx)

    def quad(self, mat, a, b, c, d):
        """a flat quad a-b-c-d (counter-clockwise seen from its front), split into two triangles"""
        a, b, c, d = (np.asarray(p, float) for p in (a, b, c, d))
        n = np.cross(b - a, c - a); L = np.linalg.norm(n)
        n = n / L if L > 1e-9 else np.array([0, 1, 0.0])
        self.tris(mat, [a, b, c, d], [n] * 4, [0, 1, 2, 0, 2, 3])

    def grid(self, mat, P, up=True):
        """a smooth surface from a (rows, cols, 3) array of points; normals from the grid itself,
        turned so they point up (`up=True`) or down — the side a roof or a soffit is seen from"""
        P = np.asarray(P, float); r, c = P.shape[:2]
        du = np.gradient(P, axis=0); dv = np.gradient(P, axis=1)
        N = np.cross(du, dv); L = np.linalg.norm(N, axis=2, keepdims=True); N = N / np.where(L < 1e-9, 1, L)
        flip = (N[..., 1].mean() < 0) == bool(up)
        if flip: N = -N
        idx = []
        for i in range(r - 1):
            for j in range(c - 1):
                a = i * c + j; b = a + 1; d = a + c; e = d + 1
                idx += ([a, b, e, a, e, d] if flip else [a, d, e, a, e, b])
        self.tris(mat, P.reshape(-1, 3), N.reshape(-1, 3), idx)

    def cap(self, mat, ring, y, up=True):
        """a flat polygon at height y over a plan ring [(x,z)...]; fan from the centroid, so the ring must see its centroid"""
        ring = [(float(x), float(z)) for x, z in ring]
        if signed_area(ring) > 0: ring = ring[::-1]
        cx = sum(x for x, _ in ring) / len(ring); cz = sum(z for _, z in ring) / len(ring)
        pts = [(cx, y, cz)] + [(x, y, z) for x, z in ring]
        n = (0, 1, 0) if up else (0, -1, 0)
        idx = []
        for i in range(len(ring)):
            a, b = 1 + i, 1 + (i + 1) % len(ring)
            idx += ([0, a, b] if up else [0, b, a])
        self.tris(mat, pts, [n] * len(pts), idx)

    def collar(self, mat, inner, outer, y):
        """a flat band at height y between an inner ring and an outer ring that both see the inner ring's centre"""
        inner = [(float(x), float(z)) for x, z in inner]
        if signed_area(inner) > 0: inner = inner[::-1]
        cx = sum(x for x, _ in inner) / len(inner); cz = sum(z for _, z in inner) / len(inner)
        outer = [(float(x), float(z)) for x, z in outer]

        def hit(x, z):
            # where the ray from the centre through (x, z) meets the outer ring
            dx, dz = x - cx, z - cz; best = None
            for i in range(len(outer)):
                (ax, az), (bx, bz) = outer[i], outer[(i + 1) % len(outer)]
                ex, ez = bx - ax, bz - az
                den = dx * ez - dz * ex
                if abs(den) < 1e-12: continue
                s = ((ax - cx) * ez - (az - cz) * ex) / den
                u = ((ax - cx) * dz - (az - cz) * dx) / den
                if s > 0 and -1e-9 <= u <= 1 + 1e-9 and (best is None or s < best): best = s
            return (cx + dx * best, cz + dz * best) if best else (x, z)

        out = [hit(x, z) for x, z in inner]
        for i in range(len(inner)):
            a, b = inner[i], inner[(i + 1) % len(inner)]; c, d = out[(i + 1) % len(inner)], out[i]
            self.quad(mat, (a[0], y, a[1]), (d[0], y, d[1]), (c[0], y, c[1]), (b[0], y, b[1]))

    def extrude(self, mat, ring, y0, y1, top=None, bottom=True, side=True, lid=True):
        """a prism over a plan ring from y0 to y1; `top` may be another material; `lid=False` leaves it open"""
        ring = [(float(x), float(z)) for x, z in ring]
        if signed_area(ring) > 0: ring = ring[::-1]           # with x east and z south, a ring seen counter-clockwise from above has negative area here
        if side:
            for i in range(len(ring)):
                (ax, az), (bx, bz) = ring[i], ring[(i + 1) % len(ring)]
                self.quad(mat, (ax, y0, az), (bx, y0, bz), (bx, y1, bz), (ax, y1, az))
        if lid: self.cap(top or mat, ring, y1, up=True)
        if bottom: self.cap(mat, ring, y0, up=False)

    def sweep(self, mat, path, w, h, up=(0, 1, 0)):
        """a w×h rectangular section swept along a 3D polyline; `h` is along `up`, `w` across"""
        P = np.asarray(path, float)
        if len(P) < 2: return
        T = np.gradient(P, axis=0); T /= np.maximum(np.linalg.norm(T, axis=1, keepdims=True), 1e-9)
        up = np.asarray(up, float)
        C = np.zeros((len(P), 4, 3))
        for i, t in enumerate(T):
            side = np.cross(up, t); L = np.linalg.norm(side)
            side = side / L if L > 1e-9 else np.array([1, 0, 0.0])
            u = np.cross(t, side); u /= max(np.linalg.norm(u), 1e-9)
            s, u = side * w / 2, u * h / 2
            C[i] = [P[i] - s - u, P[i] + s - u, P[i] + s + u, P[i] - s + u]
        for i in range(len(P) - 1):
            for k in range(4):
                a, b = C[i][k], C[i][(k + 1) % 4]; c, d = C[i + 1][(k + 1) % 4], C[i + 1][k]
                self.quad(mat, a, b, c, d)
        self.quad(mat, C[0][3], C[0][2], C[0][1], C[0][0])
        self.quad(mat, C[-1][0], C[-1][1], C[-1][2], C[-1][3])

    # ---- walkability -------------------------------------------------------------------------

    def floor(self, ring, top, name=''):
        self.walk['floors'].append({'name': name, 'ring': [[round(float(x), 3), round(float(z), 3)] for x, z in ring], 'top': round(float(top), 3)})

    def solid(self, ring, base, top, name=''):
        self.walk['solids'].append({'name': name, 'ring': [[round(float(x), 3), round(float(z), 3)] for x, z in ring], 'base': round(float(base), 3), 'top': round(float(top), 3)})

    # ---- file --------------------------------------------------------------------------------

    def write(self, path, extras=None):
        blobs = []; views = []; accessors = []; meshes = []; materials = []; nodes = []
        off = 0

        def push(arr, target):
            nonlocal off
            b = arr.tobytes(); pad = (-len(b)) % 4
            blobs.append(b + b'\0' * pad)
            views.append({'buffer': 0, 'byteOffset': off, 'byteLength': len(b), 'target': target})
            off += len(b) + pad
            return len(views) - 1

        tri_count = 0
        for mi, (mat, (P, N, I)) in enumerate(self.parts.items()):
            materials.append(mat.gltf())
            pos = np.asarray(P, np.float32); nrm = np.asarray(N, np.float32)
            idx = np.asarray(I, np.uint32)
            tri_count += len(idx) // 3
            vp = push(pos, 34962); vn = push(nrm, 34962); vi = push(idx, 34963)
            accessors.append({'bufferView': vp, 'componentType': 5126, 'count': len(pos), 'type': 'VEC3',
                              'min': pos.min(axis=0).tolist(), 'max': pos.max(axis=0).tolist()})
            accessors.append({'bufferView': vn, 'componentType': 5126, 'count': len(nrm), 'type': 'VEC3'})
            accessors.append({'bufferView': vi, 'componentType': 5125, 'count': len(idx), 'type': 'SCALAR'})
            a = len(accessors) - 3
            meshes.append({'name': mat.name, 'primitives': [{'attributes': {'POSITION': a, 'NORMAL': a + 1}, 'indices': a + 2, 'material': mi}]})
            nodes.append({'name': mat.name, 'mesh': len(meshes) - 1})
        root = {'name': self.name, 'children': list(range(len(nodes))), 'extras': {'walk': self.walk, **(extras or {})}}
        nodes.append(root)
        doc = {
            'asset': {'version': '2.0', 'generator': 'spatial-map massing', 'copyright': 'Sacred Rebel'},
            'scene': 0, 'scenes': [{'name': self.name, 'nodes': [len(nodes) - 1], 'extras': root['extras']}],
            'nodes': nodes, 'meshes': meshes, 'materials': materials,
            'accessors': accessors, 'bufferViews': views, 'buffers': [{'byteLength': off}]
        }
        js = json.dumps(doc, separators=(',', ':')).encode()
        js += b' ' * ((-len(js)) % 4)
        bin_ = b''.join(blobs)
        total = 12 + 8 + len(js) + 8 + len(bin_)
        with open(path, 'wb') as f:
            f.write(struct.pack('<III', 0x46546C67, 2, total))
            f.write(struct.pack('<II', len(js), 0x4E4F534A)); f.write(js)
            f.write(struct.pack('<II', len(bin_), 0x004E4942)); f.write(bin_)
        return {'bytes': total, 'triangles': tri_count, 'meshes': len(meshes)}


def signed_area(ring):
    s = 0.0
    for i in range(len(ring)):
        (ax, az), (bx, bz) = ring[i], ring[(i + 1) % len(ring)]
        s += ax * bz - bx * az
    return s / 2


def circle(cx, cz, r, n=32, y=None):
    pts = [(cx + r * math.cos(2 * math.pi * i / n), cz + r * math.sin(2 * math.pi * i / n)) for i in range(n)]
    return pts if y is None else [(x, y, z) for x, z in pts]


def rect(x0, z0, x1, z1):
    return [(x0, z0), (x1, z0), (x1, z1), (x0, z1)]


def inside(x, z, ring):
    hit = False
    for i in range(len(ring)):
        (ax, az), (bx, bz) = ring[i], ring[i - 1]
        if (az > z) != (bz > z) and x < (bx - ax) * (z - az) / (bz - az) + ax: hit = not hit
    return hit
