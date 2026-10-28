import { Vector3 } from 'three'
import { Quaternion } from 'three'
import { SuperCurve, quaternionFromFrame } from './SuperCurve.js';
import * as tram from '../utils/tram.js'

class CircleSuperCurve3 extends SuperCurve {

  constructor(centerPoint, axisOfRotation, pointOnCircle, length, normalInwards = false) {

    // If the length is positive, the curve starts at pointOnCircle. If the length is negative, the curve ends at pointOnCircle.
    super();
    this.isCircleSuperCurve3 = true;
    this.type = 'CircleSuperCurve3';

    this.update(centerPoint, axisOfRotation, pointOnCircle, length, normalInwards)

  }

  update(centerPoint, axisOfRotation, pointOnCircle, length, normalInwards = false) {

    this.centerPoint = centerPoint
    this.axisOfRotation = axisOfRotation // Perhaps this should be called "circleNormal"
    this.pointOnCircle = pointOnCircle
    // ToDo: Don't like this API where negative lengths are allowed. Better to add another parameter.
    this.length = Math.abs(length)
    this.lengthSign = Math.sign(length)
    this.normalInwards = normalInwards
    this.centerToPointOnCircle = pointOnCircle.clone().sub(centerPoint)
    this.radius = this.centerToPointOnCircle.length()
    this.normalizedCenterToPointOnCircle = this.centerToPointOnCircle.clone().normalize()
    // Copy before normalising so the caller's vector is not mutated
    this.axisOfRotation = axisOfRotation.clone().normalize()
    this.binormal = this.axisOfRotation.clone()
    this.duration = 0;

  }

  getLength() {
    return this.length
  }
  
  setDuration(duration) {
    this.duration = duration
  }

  getDuration() {
    return this.duration
  }

  getPoint(i, optionalTarget) {
    return this.getPointAt(i, optionalTarget)
  }

  getPointAt(d, optionalTarget) {
    // d is a number from 0 to 1 which indicates the desired distance along the curve 
    const point = optionalTarget || new Vector3();
    const angle = (this.lengthSign>0) ? d * this.length / this.radius : (-1 + d) * this.length / this.radius
    point.copy(this.centerToPointOnCircle)
    point.applyAxisAngle(this.axisOfRotation, angle).add(this.centerPoint)
    return point
  }

  getTangent(i, optionalTarget) {
    return this.getTangentAt(i, optionalTarget)
  }

  getTangentAt(d, optionalTarget) {
    // d is a number from 0 to 1 which indicates the desired distance along the curve 
    const vector = optionalTarget || new Vector3();
    const angle = (this.lengthSign>0) ? d * this.length / this.radius : (-1 + d) * this.length / this.radius
    vector.copy(this.normalizedCenterToPointOnCircle)
    vector.applyAxisAngle(this.axisOfRotation, angle + Math.PI/2)
    return vector
  }

  getNormal(i, optionalTarget) {
    return this.getNormalAt(i, optionalTarget)
  }

  getNormalAt(d, optionalTarget) {
    // d is a number from 0 to 1 which indicates the desired distance along the curve 
    const vector = optionalTarget || new Vector3();
    const angle = (this.lengthSign>0) ? d * this.length / this.radius : (-1 + d) * this.length / this.radius
    vector.copy(this.normalizedCenterToPointOnCircle)
    vector.applyAxisAngle(this.axisOfRotation, angle)
    if (this.normalInwards) vector.negate()
    return vector
  }

  getBinormal(i, optionalTarget) {
    const vector = optionalTarget || new Vector3();
    vector.copy(this.binormal)
    if (this.normalInwards) vector.negate()
    return vector
  }

  getBinormalAt(d, optionalTarget) {
    const vector = optionalTarget || new Vector3();
    vector.copy(this.binormal)
    if (this.normalInwards) vector.negate()
    return vector
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

  getQuaternion(i, objectForward = new Vector3(0, 1, 0), objectUpward = new Vector3(0, 0, 1), optionalTarget = new Quaternion() ) {
    return this.getQuaternionAt(i, objectForward, objectUpward, optionalTarget)
  }

  getQuaternionAt(d, objectForward = new Vector3(0, 1, 0), objectUpward = new Vector3(0, 0, 1), optionalTarget = new Quaternion() ) {

    return quaternionFromFrame(this.getTangentAt(d), this.getNormalAt(d), objectForward, objectUpward, optionalTarget)
  }

  getStartFinishZoneIndices(sphereCenter, sphereRadius) {

    const circleCenter = this.centerPoint.clone()
    const circleNormal = this.axisOfRotation.clone().normalize()
    const circleRadius = this.radius
    const intersections = tram.findCircleSphereIntersections(circleCenter, circleNormal, circleRadius, sphereCenter, sphereRadius)

    const dValues = []
    intersections.forEach(intersection => {
      const dValue = this.convertPointToDValue(intersection)
      if (dValue>=0 && dValue<=1) dValues.push(dValue)
    })

    const startPoint = this.getPointAt(0)

    // Check if either of the curve's endpoints are inside (or on) the sphere...
    if (startPoint.distanceTo(sphereCenter) <= sphereRadius) {
      dValues.push(0)
    }
    const endPoint = this.getPointAt(1)
    if (endPoint.distanceTo(sphereCenter) <= sphereRadius) {
      dValues.push(1)
    }

    if (dValues.length==1) {
      console.log("Warning: Circle curve really should not have only one intersetion point with a sphere if the algorithm is working correctly...")
      // But we'll handle it anyway...
      dValues.push(dValues[0])
    }
    if (dValues.length>=2) {
      dValues.sort((x, y) => x - y)  // numeric sort (the default sort compares strings)
      return [dValues[0], dValues[dValues.length-1]]
    }
    else {
      return []
    }

  }

  convertPointToDValue(point) {

    const zeroVector = this.getPointAt(0).sub(this.centerPoint)
    const pointVector = point.clone().sub(this.centerPoint)
    // atan2 gives the full signed angle (asin was only valid below 90 degrees and NaN-prone at +/-1)
    const sinPart = zeroVector.clone().cross(pointVector).dot(this.axisOfRotation)
    const cosPart = zeroVector.dot(pointVector)
    let angle = Math.atan2(sinPart, cosPart)
    // The arc always runs in the positive sense from its d=0 point, so measure the angle in [0, 2pi).
    if (angle < 0) angle += 2 * Math.PI
    const dValue = angle * this.radius / this.length
    return dValue

  }

}

export { CircleSuperCurve3 };
