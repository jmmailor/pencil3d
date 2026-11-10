# Pencil3D

Pencil3D is a phone web app (built for iPhone Safari) for drawing 3D lines in the air or on the desk with a pencil. It uses only the camera. The lines stay fixed in space over the live camera image and export to **Rhino (.3dm)**, **OBJ**, **DXF** and **FBX**.

Everything runs on the phone: no accounts, no cloud and no network after the first load (it works offline as a Home Screen app).

## How it works
* A printed **desk sheet** with a ring of ArUco markers defines the 3D world: origin at the sheet centre, X right, Y away from you, Z up. Units are cm.
* A small printed **cube on the end of the pencil** gives the pencil's full 6-DoF pose. The tip position comes from a one-time *pivot calibration*.
* Marker detection (js-aruco2), sub-pixel corner refinement and pose solving run in a Web Worker. three.js draws the overlay.
* Strokes are smoothed (adjustable), optionally straightened and snapped, and fitted with cubic NURBS for export.

## Setup
1. Open `print.html` and print the sheet and the cube at **100 %**. Check that the sheet's black squares measure 3.0 cm.
2. Tape the sheet to the desk and put the phone on a stand looking down at it at roughly 30–60°.
3. Fold the cube (print outside) and push the pencil's eraser end into the hole.
4. In the app: **Setup → paper, cube size, pencil length**, then **Calibrate tip**.
5. Hold **Hold to draw** while moving the pencil.

## Features
* Draw in the air, on the desk surface, or in the air with auto-snap to the desk.
* Colours, thickness, smoothing, auto-straighten.
* Undo/redo, select (tap), delete, duplicate, move (XY or Z), restyle.
* Layers with names, colours and visibility.
* 1 cm grid, mirror plane, end and grid snapping, live tip coordinates and measurements.
* Saved drawings on the device (IndexedDB) plus autosave.
* Export: units (mm/cm/m/in), origin (tapped point, bounding-box corner or sheet centre), polylines / NURBS / both, and optional tube meshes (diameter = line thickness). Layers and colours carry over. Files go out through the iOS share sheet.
* *Plain pencil (test)* mode: follows a coloured tip on a flat plane. It has no depth.

## Format notes
| Format | Curves | NURBS | Tubes | Layers / colours |
|---|---|---|---|---|
| .3dm | polyline | ✓ native | mesh | ✓ / ✓ |
| .obj + .mtl | `l` lines | `curv` (Rhino reads it; many other apps ignore it) | mesh | groups / materials |
| .dxf (R12) | 3D polyline | – (polyline only) | 3DFACE | ✓ / nearest ACI |
| .fbx (ASCII 7.4) | degree-1 NURBS | ✓ | mesh | names / materials |

Blender cannot import ASCII FBX; use OBJ for Blender.

## Hosting
The camera requires https. Push to GitHub and enable **Settings → Pages → Source: GitHub Actions**; the included workflow publishes the site. Open the URL in Safari, then **Share → Add to Home Screen**.

Run locally: `npm run serve`, then open http://localhost:8123. The camera only works on localhost or over https.

## Tests
* `test/synth.html` renders the sheet and pen cube with known poses and measures tracking error.
* `test/genvideo.html` renders a fake camera video for end-to-end tests in headless Chromium.
