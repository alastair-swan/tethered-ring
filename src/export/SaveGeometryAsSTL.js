//import * as THREE from 'three'
import { STLExporter } from 'three/addons/exporters/STLExporter.js';

// import { saveAs } from './FileSaver.js'
// import { saveAs } from 'file-saver';

export function define_SaveGeometryAsSTL() {
  return function (geometry, filename) {

    var exporter = new STLExporter();
    var str = exporter.parse( geometry ); // Export the screw geometry
    //console.log(str)
    
    var blob = new Blob( [str], { type : 'text/plain' } ); // Generate Blob from the string
    //saveAs( blob, 'file.stl' ); //Save the Blob to file.stl

    // var blob = new Blob([geometry.exportSTL()], {
    //   type: 'text/plain'
    // });
    // link.style.display = 'none';
    // document.body.appendChild(link);
    // link.href = URL.createObjectURL(blob);
    // link.download = 'Scene.stl';
    // link.click();

    const link = document.createElement('a');
    const url = window.URL.createObjectURL(blob);
    link.href = url;
    link.download = filename;
    link.click();
    // Release the blob once the download has been handed to the browser (it used to leak)
    setTimeout(() => window.URL.revokeObjectURL(url), 0);
  }
}