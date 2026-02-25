# 📜 THE GITNEXUS CANON (V1.0)
**Visual Identity:** Sleek Atomic Orange & Black
**Architecture:** Deterministic, State-Driven, Atomic

## SECTION 1: VISUAL AXIOMS
* Void (Base): `#000000` (`bg-black`)
* Surface (High): `#18181b` (`bg-zinc-900`)
* Atomic Action: `#f97316` (`text-orange-500`)
* Primary Text: `#f4f4f5` (`text-zinc-100`)

## SECTION 2: COMPONENT ARCHITECTURE
Files must be located in `client/src/components/` following Atom, Molecule, Organism hierarchy.

## SECTION 3: DATA FLOW
Frontend must validate data upon receipt from the API using Zod schemas. 
States: IDLE, LOADING, SUCCESS, ERROR.
