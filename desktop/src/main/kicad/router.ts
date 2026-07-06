// KiCad PNS push-and-shove router, ported to WASM, loaded in the Electron main process.
// The Emscripten glue (route.js) + route.wasm live under kicad/wasm/ and are copied to the
// build output by webpack (copy-webpack-plugin). We load them at runtime via a non-webpack
// require so webpack doesn't try to bundle the Emscripten module.
import * as path from 'path';

declare const __non_webpack_require__: NodeRequire;

export interface RoutePoint { x: number; y: number; }   // millimetres (demo) / nanometres (session)
export interface Obstacle { cx: number; cy: number; hw: number; hh: number; }   // nanometres
export interface SegObstacle { x1: number; y1: number; x2: number; y2: number; width: number; layer: number; }  // nm
export interface RouteItem { kind: number; ax: number; ay: number; bx: number; by: number; layer: number; }  // nm; kind 0=seg 1=via

let modulePromise: Promise<any> | null = null;

function loadModule(): Promise<any> {
    if( modulePromise )
        return modulePromise;

    modulePromise = ( async () => {
        const routeJs = path.join( __dirname, 'kicad', 'wasm', 'route.js' );
        // MODULARIZE build: require returns a factory that resolves to the ready module.
        const createRouterModule = __non_webpack_require__( routeJs );
        return await createRouterModule();
    } )();

    return modulePromise;
}

/**
 * Demo route: place a 0.25 mm track from (0,0) to (20,0) mm, optionally around a keepout
 * block, using KiCad's real walkaround (mode 0) or shove (mode 1) engine. Returns the
 * routed polyline in millimetres.
 */
export async function routeDemo( withObstacle: boolean, mode: 'walkaround' | 'shove' ): Promise<RoutePoint[]> {
    const M = await loadModule();
    const modeNum = mode === 'shove' ? 1 : 0;

    const verts = M.ccall( 'route_run', 'number', [ 'number', 'number' ], [ withObstacle ? 1 : 0, modeNum ] );
    if( verts < 0 )
        throw new Error( 'route_run failed (StartRouting returned false)' );

    const count = M.ccall( 'route_point_count', 'number', [], [] );
    const pts: RoutePoint[] = [];
    for( let i = 0; i < count; i++ ) {
        pts.push( {
            x: M.ccall( 'route_point_x', 'number', [ 'number' ], [ i ] ),
            y: M.ccall( 'route_point_y', 'number', [ 'number' ], [ i ] ),
        } );
    }
    return pts;
}

// ---------------- interactive routing session (all coords in nanometres) ----------------

function readSessionPath( M: any ): RoutePoint[] {
    const n = M.ccall( 'route_nm_count', 'number', [], [] );
    const pts: RoutePoint[] = [];
    for( let i = 0; i < n; i++ ) {
        pts.push( {
            x: M.ccall( 'route_nm_x', 'number', [ 'number' ], [ i ] ),
            y: M.ccall( 'route_nm_y', 'number', [ 'number' ], [ i ] ),
        } );
    }
    return pts;
}

// The full committed geometry (segments + vias, each with its copper layer).
function readItems( M: any ): RouteItem[] {
    const n = M.ccall( 'item_count', 'number', [], [] );
    const items: RouteItem[] = [];
    for( let i = 0; i < n; i++ ) {
        items.push( {
            kind: M.ccall( 'item_kind', 'number', [ 'number' ], [ i ] ),
            ax: M.ccall( 'item_ax', 'number', [ 'number' ], [ i ] ),
            ay: M.ccall( 'item_ay', 'number', [ 'number' ], [ i ] ),
            bx: M.ccall( 'item_bx', 'number', [ 'number' ], [ i ] ),
            by: M.ccall( 'item_by', 'number', [ 'number' ], [ i ] ),
            layer: M.ccall( 'item_layer', 'number', [ 'number' ], [ i ] ),
        } );
    }
    return items;
}

/** Rebuild the router world from rectangular obstacles (parts) + segment obstacles
 *  (already-placed tracks), then arm the router. */
export async function routeSetup( obstacles: Obstacle[], segments: SegObstacle[],
                                  mode: 'walkaround' | 'shove',
                                  trackWidth: number, clearance: number ): Promise<void> {
    const M = await loadModule();
    M.ccall( 'world_reset', 'void', [], [] );
    for( const o of obstacles )
        M.ccall( 'world_add_rect', 'void', [ 'number', 'number', 'number', 'number' ],
                 [ o.cx, o.cy, o.hw, o.hh ] );
    for( const s of ( segments || [] ) )
        M.ccall( 'world_add_segment', 'void', [ 'number', 'number', 'number', 'number', 'number', 'number' ],
                 [ s.x1, s.y1, s.x2, s.y2, s.width, s.layer || 0 ] );
    M.ccall( 'world_build', 'number', [ 'number', 'number', 'number' ],
             [ mode === 'shove' ? 1 : 0, trackWidth, clearance ] );
}

/** Begin a routing session at (x,y) nm. */
export async function routeStart( x: number, y: number, layer: number ): Promise<boolean> {
    const M = await loadModule();
    return M.ccall( 'route_start', 'number', [ 'number', 'number', 'number' ], [ x, y, layer ] ) === 1;
}

/** Move the cursor to (x,y) nm; returns the live walked-around preview polyline (nm). */
export async function routeMove( x: number, y: number ): Promise<RoutePoint[]> {
    const M = await loadModule();
    M.ccall( 'route_move', 'number', [ 'number', 'number' ], [ x, y ] );
    return readSessionPath( M );
}

/** Commit the route at (x,y) nm; returns the committed geometry (segments + vias, layered). */
export async function routeFinish( x: number, y: number ): Promise<RouteItem[]> {
    const M = await loadModule();
    M.ccall( 'route_finish', 'number', [ 'number', 'number' ], [ x, y ] );
    return readItems( M );
}

/** One-shot pad-to-pad route on the current world (nm); returns committed geometry (layered). */
export async function routeAB( x1: number, y1: number, x2: number, y2: number,
                               layer: number ): Promise<RouteItem[]> {
    const M = await loadModule();
    M.ccall( 'route_ab', 'number', [ 'number', 'number', 'number', 'number', 'number' ],
             [ x1, y1, x2, y2, layer ] );
    return readItems( M );
}
