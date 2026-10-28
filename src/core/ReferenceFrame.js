// A reference frame moves objects around a closed curve (the tethered ring, or a launcher path).
// The frame is divided into `numZones` "wedges"; each wedge holds lists of virtual objects so that
// only the wedges near the camera need to have real three.js models allocated to them.
//
// Positions along the curve are fractions in [0, 1). An object stored at in-frame position `p`
// lives in wedge `wedgeIndexFor(p)` and is rendered at curve position `posFrac(p + frame.p)`.

function posFrac(x) {
	return x - Math.floor(x)
}

export class referenceFrame {
	constructor(curve, numZones, cameraRange, velocity, direction, trackIndex, name) {
		this.curve = curve  // The curve along which objects will be placed
		this.numZones = numZones  // Number of wedges the frame is divided into for dynamic model allocation
		this.cameraRange = cameraRange  // Distance (m) from the camera within which wedges get models
		this.p = 0  // Position of the frame around the (closed) curve, as a fraction
		this.v = velocity  // Speed (m/s, non-negative) at which the frame moves along the curve
		this.direction = direction  // +1 when p increases with time, -1 when it decreases
		this.trackIndex = trackIndex
		this.name = name
		this.startWedgeIndex = -1
		this.finishWedgeIndex = -1
		this.prevStartWedgeIndex = -1
		this.prevFinishWedgeIndex = -1
		this.placeholderEntries = {}
		// Optional exact motion model. When set, `positionFunction(animationTime)` returns the frame's
		// position fraction and `futureP(dt)` uses it, so that look-ahead accounts for acceleration.
		this.positionFunction = null
		this.animationTime = 0
		this.timeRate = 1  // 0 while the frame's animation is paused
	}

	initialize() {
		// In each frame-of-reference, create an array of wedges. In each wedge, create an empty array for storing the virtual objects in that wedge
		const makeEmptyArrays = () => { return structuredClone(this.placeholderEntries) }
		this.wedges = new Array(this.numZones).fill().map(makeEmptyArrays)
	}

	addVirtualObject( virtualObjectName ) {
		this.placeholderEntries[virtualObjectName] = []
		if (this.wedges) this.wedges.forEach(wedge => { if (!(virtualObjectName in wedge)) wedge[virtualObjectName] = [] })
	}

	setCurve(curve) {
		this.curve = curve
		this.update()
	}

	// The wedge that stores an object whose in-frame position is p. Always use this (and nothing else)
	// so that storage and visibility tests agree.
	wedgeIndexFor(p) {
		return Math.min(this.numZones - 1, Math.floor(posFrac(p) * this.numZones))
	}

	// Position of the frame `dt` seconds after the current animation time.
	futureP(dt) {
		const t = this.animationTime + this.timeRate * dt
		if (this.positionFunction) return posFrac(this.positionFunction(t))
		const circumference = (this.curve && this.curve.getLength) ? this.curve.getLength() : 1
		return posFrac(this.p + this.direction * this.v * this.timeRate * dt / circumference)
	}

	update() {
		// We need to map the wedges to the individual curves in the list of curves
		if (Array.isArray(this.curve)) {
			if (this.curve.length==0) console.log("Error: Array length cannot be zero")
			this.numZonesPerCurve = []
			let curvesTotalLength = 0
			this.curve.forEach(subCurve => { curvesTotalLength += Math.abs(subCurve.getLength()) })
			const wedgeRoughLength = curvesTotalLength / this.numZones
			const numCurveSegments = this.curve.length
			// Make sure that every curve gets assigned at least one segment
			let newNumWedges = 0
			this.curve.forEach((subCurve, index) => {
				const subCurveLength = Math.abs(subCurve.getLength())
				this.numZonesPerCurve[index] = 1 + Math.max(0, Math.round((this.numZones - numCurveSegments) * (subCurveLength - wedgeRoughLength) / (curvesTotalLength - numCurveSegments * wedgeRoughLength)))
				newNumWedges += this.numZonesPerCurve[index]
			})
			// Adjust the number of wedges assigned to the last curve so that the total number of wedges is unchanged
			// (The old code wrote to index -1, which silently did nothing.)
			const last = this.numZonesPerCurve.length - 1
			this.numZonesPerCurve[last] = Math.max(1, this.numZonesPerCurve[last] + this.numZones - newNumWedges)
		}
	}
}
