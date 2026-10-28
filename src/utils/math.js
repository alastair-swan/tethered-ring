// General-purpose math, vector helper classes, optimizers and curve utilities.
import * as THREE from 'three'

export function lerp (start, end, amt) {
  return (1-amt)*start+amt*end
}

export function clamp(num, min, max) {
  return Math.min(Math.max(num, min), max)
}

export function sign(num) {
  if (num<0) {
    return -1
  }
  else if (num>0) {
    return 1
  }
  else {
    return 0
  }
}

export function posFrac(num) {
  return num - Math.floor(num)
}

// Returns a "delta r" in the ring-centered cylindrical coordinate space relative to the middlemost main ring  
export class forceVector {
  constructor(ρ, φ, z) {
    this.ρ = ρ            // Distance from the ring's axis of symmetry
    this.φ = φ            // Angle around the ring's axis of symmetry
    this.z = z            // Distance along the ring's axis of symmetry from the center of the ring
  }
}

export class cateneryVector {
  constructor(x, y, s, θ, T, crossSectionalArea) {
    this.x = x            // Distance from the origin (center of planet)
    this.y = y            // Angle from the ring's axis of symmetry
    this.s = s            // Distance along the catenery from the anchor point (Point B)
    this.θ = θ
    this.T = T
  }
}

export class CylindricalVector3 {
  constructor (r, θ, y) {
    this.r = r
    this.θ = θ
    this.y = y
  }
}

export class CatenaryPolarVec3 {
  constructor(r, ω, s, crossSectionalArea) {
    this.r = r            // Distance from the origin (center of planet)
    this.ω = ω            // Angle from the ring's axis of symmetry
    this.s = s            // Distance along the tether measured from x=0 on the catenary
    this.crossSectionalArea = crossSectionalArea   // The cross-sectional area of a cable of constant stress, following this catenary curve
  }
}

export class latLonAlt {
  constructor(lat, lon, alt) {
    this.lat = lat
    this.lon = lon
    this.alt = alt            // altitude in meters
  }
}

export class Vector3 {
  constructor(x, y, z) {
    this.x = x
    this.y = y
    this.z = z            // altitude in meters
  }
}

// Helper function to calculate the magnitude squared of a vector.
Vector3.prototype.magnitudeSquared = function () {
  return this.x * this.x + this.y * this.y + this.z * this.z;
};

export function solveQuadratic(a, b, c) {
    var result1 = (-1 * b + Math.sqrt(Math.pow(b, 2) - (4 * a * c))) / (2 * a)
    var result2 = (-1 * b - Math.sqrt(Math.pow(b, 2) - (4 * a * c))) / (2 * a)
    return [result1, result2]
}

export function findCircleSphereIntersections(circleCenter, circleNormal, circleRadius, sphereCenter, sphereRadius) {
  // Step 2: Find the intersection of the circle plane and the sphere (a circle on the sphere's surface).
  // Project the sphere center onto the circle plane.
  const circleCenterToSphereCenter = new THREE.Vector3(sphereCenter.x - circleCenter.x, sphereCenter.y - circleCenter.y, sphereCenter.z - circleCenter.z);
  const projectionLength = circleCenterToSphereCenter.x * circleNormal.x + circleCenterToSphereCenter.y * circleNormal.y + circleCenterToSphereCenter.z * circleNormal.z;
  if (Math.abs(projectionLength)>sphereRadius) {
    // Sphere too far away...
    return [];
  }
  else {
    const projection = new THREE.Vector3(circleNormal.x * projectionLength, circleNormal.y * projectionLength, circleNormal.z * projectionLength);
    const projectedSphereCenterOnCirclePlane = new THREE.Vector3(sphereCenter.x - projection.x, sphereCenter.y - projection.y, sphereCenter.z - projection.z);
    const radiusOfCircleOfIntercetion = Math.sin(Math.acos(projectionLength/sphereRadius)) * sphereRadius 

    let c1, r1, c2, r2
    if (circleRadius>=radiusOfCircleOfIntercetion) {
      c1 = projectedSphereCenterOnCirclePlane
      r1 = radiusOfCircleOfIntercetion
      c2 = circleCenter
      r2 = circleRadius
    }
    else {
      c1 = circleCenter
      r1 = circleRadius
      c2 = projectedSphereCenterOnCirclePlane
      r2 = radiusOfCircleOfIntercetion
    }
    const cdiff = c1.clone().sub(c2)
    const cdifflen = cdiff.length()
    if ((cdifflen+r1<=r2) || (cdifflen-r1>=r2)) {
      // Sphere too far away...
      return [];
    }
    else {
      const cdiffnorm = cdiff.clone().normalize() //unit vector
      const cdiffperp = cdiffnorm.clone().cross(circleNormal)
      const q = cdifflen**2 + r2**2 - r1**2
      const dx = 1/2 * q / cdifflen
      const dy = 1/2 * Math.sqrt(4 * cdifflen**2 * r2**2 - q**2) / cdifflen
      const dxvect = cdiffnorm.clone().multiplyScalar(dx)
      const dyvect = cdiffperp.clone().multiplyScalar(dy)
      const intersection1 = c2.clone().add(dxvect).add(dyvect)
      const intersection2 = c2.clone().add(dxvect).sub(dyvect)

      if (Number.isNaN(dy)) {
        console.log("Nan Error")
      }

      return [intersection1, intersection2];
    }
  }
}

export function getDodecahedronFaceCoordinates() {
  const phi = (1 + Math.sqrt(5)) / 2; // The golden ratio
  const a = 1;

  const vertices = [
    [0, a, phi * a],
    [0, -a, phi * a],
    [0, a, -phi * a],
    [0, -a, -phi * a],

    [a, phi * a, 0],
    [-a, phi * a, 0],
    [a, -phi * a, 0],
    [-a, -phi * a, 0],

    [phi * a, 0, a],
    [-phi * a, 0, a],
    [phi * a, 0, -a],
    [-phi * a, 0, -a]
  ];

  const faceCoordinates = vertices.map(vertex => ({
    lat: Math.atan2(vertex[2], Math.sqrt(vertex[0] * vertex[0] + vertex[1] * vertex[1])),
    lon: Math.atan2(vertex[1], vertex[0])
  }));

  return faceCoordinates;
}

export const tab10Colors = [
  { name: "Blue", hex: 0x1f77b4 },
  { name: "Orange", hex: 0xff7f0e },
  { name: "Green", hex: 0x2ca02c },
  { name: "Red", hex: 0xd62728 },
  { name: "Purple", hex: 0x9467bd },
  { name: "Brown", hex: 0x8c564b },
  { name: "Pink", hex: 0xe377c2 },
  { name: "Gray", hex: 0xbfbfbf },
  { name: "Yellow", hex: 0xbcbd22 },
  { name: "Cyan", hex: 0x17becf }
]


export function interpolateCurve(curve, tStep) {

  if (!curve || curve.length < 2) {
    throw new Error("Curve must have at least two points for interpolation.")
  }

  let newCurve = []
  let minTime = curve[0].x
  let maxTime = curve[curve.length - 1].x

  let i = 0 // Iterator for curve array

  for (let t = Math.ceil(minTime/tStep)*tStep; t <= maxTime; t += tStep) {
    // Move to the correct segment in the curve
    while (i < curve.length - 1 && curve[i + 1].x <= t) {
      i++
    }

    let lower = curve[i]
    let upper = curve[i + 1] || curve[i] // Prevent undefined errors at the end
    let interpolatedSpeed

    if (lower.x === t) {
      // Exact match, no need to interpolate
      interpolatedSpeed = lower.y
    } else if (upper.x > lower.x) {
      // Perform linear interpolation
      let tRatio = (t - lower.x) / (upper.x - lower.x)
      interpolatedSpeed = lower.y + tRatio * (upper.y - lower.y)
    } else {
      // If there's no valid upper bound, repeat the last known value (edge case)
      interpolatedSpeed = lower.y
    }
    newCurve.push(new THREE.Vector3(t, interpolatedSpeed, 0))
  }

  return newCurve
}

export function diffTwoCurves(curve1, curve2, maxTime) {
  if (!curve1.length || !curve2.length) {
    throw new Error("Both curves must have data points.")
  }

  let sumOfSquares = 0
  let offset = 0
  let smallerLength = Math.min(curve1.length, curve2.length)

  for (let i = 0; i < smallerLength; i++) {
    let d1 = curve1[i]

    // Ensure we don't go out of bounds
    while (i + offset < curve2.length && curve2[i + offset].x < d1.x) {
      offset++
    }

    // If offset moves out of bounds, break early
    if (i + offset >= curve2.length) break

    let d2 = curve2[i + offset]

    if (d1.x === d2.x) {
      if (d1.x<=maxTime) {
        sumOfSquares += (d1.y - d2.y) ** 2
      }
    }
    else {
      debugger
    }
  }

  let rootMeanSquaredError = Math.sqrt(sumOfSquares / smallerLength)
  return rootMeanSquaredError
}

export function optimize(testFunction, fullParams, tunableParams, maxIterations = 10, tolerance = 1e-6) {
  let params = { ...fullParams } // Copy full set of parameters (object)
  let bestParams = { ...params } // Best known parameters
  let bestValue = testFunction(bestParams)

  for (let iter = 0; iter < maxIterations; iter++) {
    let newParams = { ...bestParams } // Create a new copy
    let improved = false

    // Iterate over each tunable parameter
    for (let { key, min, max } of tunableParams) {
      let trialParamsUp = { ...bestParams }
      let trialParamsDown = { ...bestParams }
      let stepSize = (max-min)*0.01

      // Step up, ensuring within bounds
      if (trialParamsUp[key] + stepSize <= max) {
        trialParamsUp[key] += stepSize
      }
      if (trialParamsDown[key] - stepSize >= min) {
        trialParamsDown[key] -= stepSize
      }

      let valueUp = testFunction(trialParamsUp)
      let valueDown = testFunction(trialParamsDown)

      // Update if a better value is found
      if (valueUp < bestValue) {
        bestValue = valueUp
        newParams = { ...trialParamsUp }
        improved = true
      } else if (valueDown < bestValue) {
        bestValue = valueDown
        newParams = { ...trialParamsDown }
        improved = true
      }
    }

    // Check for convergence
    let change = tunableParams.reduce((sum, { key }) => sum + Math.abs(newParams[key] - bestParams[key]), 0)
    if (!improved || change < tolerance) break

    bestParams = newParams
  }

  return bestParams
}

export function adamOptimize(
  testFunction,
  fullParams,
  tunableParams,
  initialStepSize = 1, // Initial learning rate
  alpha = 1e-2, // Scaled step size factor
  maxIterations = 5,
  tolerance = 1e-6
) {
  let params = { ...fullParams }
  let bestParams = { ...params }
  let bestValue = testFunction(bestParams)

  for (let iter = 0; iter < maxIterations; iter++) {
    let gradients = {}
    let stepSize = initialStepSize

    // Compute numerical gradients with scaled step size
    for (let { key, min, max } of tunableParams) {
      let epsilon = alpha * (max - min) // Scale ε relative to parameter range

      let paramsUp = { ...bestParams }
      paramsUp[key] += epsilon
      let valueUp = testFunction(paramsUp)

      let gradient = (valueUp - bestValue) / epsilon // Finite difference approximation
      gradients[key] = gradient
      console.log("Get Grad", valueUp, key, paramsUp[key])
    }

    let newParams = { ...bestParams }
    let improved = false
    let factor = 1 // Initial movement factor
    let lastImprovementFactor = 0
    let lastBestValue = bestValue

    // Line search with backtracking
    while (true) {
      let trialParams = { ...bestParams }

      // Apply the step for all tunable parameters
      for (let { key, min, max } of tunableParams) {
        let step = -factor * stepSize * gradients[key]
        trialParams[key] = Math.min(max, Math.max(min, bestParams[key] + step))
      }

      let trialValue = testFunction(trialParams)
      console.log("Line search", trialValue, factor)

      if (trialValue < bestValue + 0.01) {  // Adding 0.01 to prevent noise from stopping the optimization early
        // If improvement is found, keep moving
        bestValue = trialValue
        newParams = { ...trialParams }
        lastImprovementFactor = factor
        factor *= 1.5 // Increase step size to accelerate convergence
      }
      else {
        // If we overshoot, start backtracking
        if (lastImprovementFactor !== 1) {
          // **Binary search backtracking**
          let left = lastImprovementFactor
          let right = factor
          let midpoint

          while ((right - left) > tolerance) {
            midpoint = (left + right) / 2
            let midParams = { ...bestParams }

            for (let { key, min, max } of tunableParams) {
              let step = -midpoint * stepSize * gradients[key]
              midParams[key] = Math.min(max, Math.max(min, bestParams[key] + step))
            }

            let midValue = testFunction(midParams)

            if (midValue < bestValue) {
              bestValue = midValue
              newParams = { ...midParams }
              left = midpoint
            } else {
              right = midpoint
            }
          }
        }
        break // Stop line search once refined
      }
    }

    // Check for significant improvement
    if (JSON.stringify(newParams) !== JSON.stringify(bestParams)) {
      improved = true
      bestParams = newParams
    }

    let newValue = testFunction(newParams)
    console.log("Walk Gradient", newValue, bestValue, newParams)

    if (!improved || stepSize < 1e-8) {
      break
    }

    stepSize *= 0.9 // Reduce step size for stability
  }

  return bestParams
}

export function gradientOptimize(testFunction, fullParams, tunableParams, learningRate = 1, epsilon = 1e-4, maxIterations = 100, tolerance = 1e-6) {
  let params = { ...fullParams }
  let bestParams = { ...params }
  let bestValue = testFunction(bestParams)

  for (let iter = 0; iter < maxIterations; iter++) {
    let gradients = {}

    // Compute numerical gradients using finite differences
    for (let { key, min, max } of tunableParams) {
      let paramsUp = { ...bestParams }
      paramsUp[key] += epsilon
      let valueUp = testFunction(paramsUp)

      let gradient = (valueUp - bestValue) / epsilon // Finite difference approximation
      gradients[key] = gradient
    }

    let newParams = { ...bestParams }
    let improved = false

    // Update parameters using the gradient
    for (let { key, min, max } of tunableParams) {
      let step = -learningRate * gradients[key] // Gradient descent step
      let updatedValue = Math.min(max, Math.max(min, bestParams[key] + step)) // Ensure within bounds

      if (Math.abs(updatedValue - bestParams[key]) > tolerance) {
        newParams[key] = updatedValue
        improved = true
      }
    }

    let newValue = testFunction(newParams)

    if (newValue < bestValue) {
      bestValue = newValue
      bestParams = newParams
    } else {
      learningRate *= 0.9 // Reduce learning rate if no improvement
    }

    if (!improved || learningRate < 1e-8) break
  }

  return bestParams
}

// ChatGPT version
export function openPlotWindow(data) {
  return new Promise((resolve, reject) => {
    const plotWindow = window.open("", "_blank", "width=800,height=600");

    if (!plotWindow) {
      reject("Popup blocked! Allow popups and try again.");
      return;
    }

    // Wait until the new window's document is fully available
    const checkWindowReady = setInterval(() => {
      if (plotWindow.document.readyState === "complete") {
        clearInterval(checkWindowReady);

        // Inject HTML and Plotly.js script
        plotWindow.document.write(`
          <html>
          <head>
            <script src="https://cdn.plot.ly/plotly-latest.min.js"></script>
          </head>
          <body>
            <div id="plot" style="width:100%;height:100%;"></div>
            <script>
              const trace = {
                x: ${JSON.stringify(data.x)},
                y: ${JSON.stringify(data.y)},
                mode: 'lines+markers',
                type: 'scatter'
              };
              Plotly.newPlot('plot', [trace]);
            </script>
          </body>
          </html>
        `);

        resolve(plotWindow);
      }
    }, 100);
  });
}

export function myFormat(value, fractionDigits = 0) {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits
  })
}

