import { Vector3 } from 'three'
import { Quaternion } from 'three'
import { SuperCurve, quaternionFromFrame } from './SuperCurve.js';

// A straight line from startPoint to endPoint. The "up" (normal) direction is interpolated between
// startPointUpDirection and endPointUpDirection. Because the parameterisation is linear, t (getPoint)
// and d (getPointAt) are the same thing for this curve.
class LineSuperCurve3 extends SuperCurve {

	constructor(startPoint = new Vector3(), endPoint = new Vector3(0, 1, 0), startPointUpDirection = new Vector3(0, 0, 1), endPointUpDirection) {
		super();
		this.isLineSuperCurve3 = true;
		this.type = 'LineSuperCurve3';
		this.startPoint = startPoint
		this.endPoint = endPoint
		this.startPointUpDirection = startPointUpDirection
		this.endPointUpDirection = endPointUpDirection || startPointUpDirection // Optional. Copy startPointUpDirection if its not given
		this.duration = 0
	}

	getLength() {
		return this.startPoint.distanceTo(this.endPoint)
	}

	getLengths(divisions = this.arcLengthDivisions) {
		const length = this.getLength()
		const lengths = []
		for (let i = 0; i <= divisions; i++) lengths.push(length * i / divisions)
		return lengths
	}

	updateArcLengths() {}

	setDuration(duration) {
		this.duration = duration
	}

	getDuration() {
		return this.duration
	}

	getPoint(t, optionalTarget) {
		return this.getPointAt(t, optionalTarget)
	}

	getPointAt(d, optionalTarget) {
		// d is a number from 0 to 1 which indicates the desired distance along the curve
		const point = optionalTarget || new Vector3();
		point.copy(this.startPoint).lerp(this.endPoint, d)
		return point
	}

	getUtoTmapping(u) {
		return u
	}

	getTangent(t, optionalTarget) {
		return this.getTangentAt(t, optionalTarget)
	}

	getTangentAt(d, optionalTarget) {
		// The parameter is not used (a line has a constant tangent) but is kept for API consistency
		const vector = optionalTarget || new Vector3();
		vector.copy(this.endPoint).sub(this.startPoint).normalize()
		return vector
	}

	getNormal(t, optionalTarget) {
		return this.getNormalAt(t, optionalTarget)
	}

	getNormalAt(d, optionalTarget) {
		// Interpolated up direction, made perpendicular to the tangent
		const vector = optionalTarget || new Vector3();
		const tangent = this.getTangentAt(d)
		vector.copy(this.startPointUpDirection).lerp(this.endPointUpDirection, d)
		vector.addScaledVector(tangent, -vector.dot(tangent)).normalize()
		return vector
	}

	getBinormal(t, optionalTarget) {
		return this.getBinormalAt(t, optionalTarget)
	}

	getBinormalAt(d, optionalTarget) {
		const vector = optionalTarget || new Vector3();
		this.getTangentAt(d, vector)
		vector.cross(this.getNormalAt(d)).normalize()
		return vector
	}

	computeFrenetFrames(segments) {
		// Note: A LineSuperCurve cannot be closed, so the "closed" parameter of the base class is ignored.
		const tangents = []
		const normals = []
		const binormals = []
		const t = this.getTangentAt(0)
		for (let i = 0; i <= segments; i++) {
			const d = (segments > 0) ? i / segments : 0
			tangents[i] = t.clone()
			normals[i] = this.getNormalAt(d)
			binormals[i] = this.getBinormalAt(d)
		}
		return { tangents, normals, binormals }
	}

	addtToiConvertor(tToiConvertor) {
		this.tToi = tToiConvertor
	}

	addtTodConvertor(tTodConvertor) {
		this.tTod = tTodConvertor
	}

	addtTosConvertor(tTosConvertor) {
		this.tTos = tTosConvertor
	}

	getQuaternion(t, objectForward = new Vector3(0, 1, 0), objectUpward = new Vector3(0, 0, 1), optionalTarget = new Quaternion()) {
		return this.getQuaternionAt(t, objectForward, objectUpward, optionalTarget)
	}

	getQuaternionAt(d, objectForward = new Vector3(0, 1, 0), objectUpward = new Vector3(0, 0, 1), optionalTarget = new Quaternion()) {
		return quaternionFromFrame(this.getTangentAt(d), this.getNormalAt(d), objectForward, objectUpward, optionalTarget)
	}

	getStartFinishZoneIndices(sphereCenter, sphereRadius) {
		// Intersect the segment with the sphere: |S + d (E - S) - C|^2 = r^2
		const dir = this.endPoint.clone().sub(this.startPoint)
		const f = this.startPoint.clone().sub(sphereCenter)
		const a = dir.lengthSq()
		if (a === 0) return (f.length() <= sphereRadius) ? [0, 1] : []
		const b = 2 * f.dot(dir)
		const c = f.lengthSq() - sphereRadius * sphereRadius
		const disc = b * b - 4 * a * c
		if (disc < 0) return []
		const sq = Math.sqrt(disc)
		const d0 = Math.max(0, (-b - sq) / (2 * a))
		const d1 = Math.min(1, (-b + sq) / (2 * a))
		return (d0 <= d1) ? [d0, d1] : []
	}

	copy(source) {
		super.copy(source)
		this.startPoint = source.startPoint.clone()
		this.endPoint = source.endPoint.clone()
		this.startPointUpDirection = source.startPointUpDirection.clone()
		this.endPointUpDirection = source.endPointUpDirection.clone()
		return this
	}

	toJSON() {
		const data = super.toJSON()
		data.startPoint = this.startPoint.toArray()
		data.endPoint = this.endPoint.toArray()
		data.startPointUpDirection = this.startPointUpDirection.toArray()
		data.endPointUpDirection = this.endPointUpDirection.toArray()
		return data
	}

	fromJSON(json) {
		super.fromJSON(json)
		this.startPoint = new Vector3().fromArray(json.startPoint)
		this.endPoint = new Vector3().fromArray(json.endPoint)
		this.startPointUpDirection = new Vector3().fromArray(json.startPointUpDirection)
		this.endPointUpDirection = new Vector3().fromArray(json.endPointUpDirection)
		return this
	}
}

export { LineSuperCurve3 };
