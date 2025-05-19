figma.showUI(__html__, { width: 450, height: 500 });

interface CSSVariable {
  name: string;
  value: string;
}

interface CSSCollection {
  name: string;
  modes: Map<string, CSSVariable[]>;
}

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'parse-css') {
    try {
      await figma.loadFontAsync({ family: "Inter", style: "Regular" });
      const collections = parseCSSVariables(msg.cssText);
      await createFigmaVariables(collections);
      figma.ui.postMessage({ 
        type: 'status', 
        message: 'Variables created successfully!', 
        status: 'success' 
      });
    } catch (error: unknown) {
      figma.ui.postMessage({ 
        type: 'status', 
        message: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`, 
        status: 'error' 
      });
    }
  }
};

function parseCSSVariables(cssText: string): CSSCollection[] {
  const collections: CSSCollection[] = [];
  let currentCollection: CSSCollection | null = null;
  let currentMode: string | null = null;
  
  // Split by CSS comment blocks to find collection and mode definitions
  const lines = cssText.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Check for collection name
    if (line.startsWith('/*') && line.includes('Collection name:')) {
      const collectionName = line.match(/Collection name:\s*([^*]+)/)?.[1]?.trim();
      if (collectionName) {
        currentCollection = {
          name: collectionName,
          modes: new Map<string, CSSVariable[]>()
        };
        collections.push(currentCollection);
      }
    }
    
    // Check for mode name
    else if (line.startsWith('/*') && line.includes('Mode:')) {
      const modeName = line.match(/Mode:\s*([^*]+)/)?.[1]?.trim();
      if (modeName && currentCollection) {
        currentMode = modeName;
        currentCollection.modes.set(currentMode, []);
      }
    }
    
    // Parse CSS variables
    else if (line.includes('--') && line.includes(':') && currentCollection && currentMode) {
      const match = line.match(/--([^:]+):\s*([^;]+);?/);
      if (match) {
        const name = match[1].trim();
        const value = match[2].trim();
        
        const variables = currentCollection.modes.get(currentMode) || [];
        variables.push({ name, value });
        currentCollection.modes.set(currentMode, variables);
      }
    }
  }
  
  return collections;
}

async function createFigmaVariables(collections: CSSCollection[]) {
  // Create a map to store variable references for aliasing
  const variableMap = new Map<string, Variable>();
  
  // First, check if we need to create any collections
  for (const collection of collections) {
    // Get all collections asynchronously
    const figmaCollections = await figma.variables.getLocalVariableCollectionsAsync();
    let figmaCollection = figmaCollections.find(c => c.name === collection.name);
    
    // Create collection if it doesn't exist
    if (!figmaCollection) {
      // Get the first mode name from our collection to use as the initial mode
      const firstModeName = Array.from(collection.modes.keys())[0] || "Default";
      
      // Create the collection with the first mode name instead of the default "Mode 1"
      figmaCollection = figma.variables.createVariableCollection(collection.name);
      
      // Rename the default mode to our first mode name
      if (figmaCollection.modes.length > 0) {
        const defaultMode = figmaCollection.modes[0];
        figmaCollection.renameMode(defaultMode.modeId, firstModeName);
      }
    }
    
    // Process each mode in the collection
    for (const [modeName, variables] of collection.modes.entries()) {
      // Check if mode exists, create if not
      let modeId = figmaCollection.modes.find(m => m.name === modeName)?.modeId;
      if (!modeId) {
        // Skip the first mode if it's already been renamed
        if (modeName === figmaCollection.modes[0]?.name) {
          modeId = figmaCollection.modes[0].modeId;
        } else {
          modeId = figmaCollection.addMode(modeName);
        }
      }
      
      // Get all variables asynchronously
      const figmaVariables = await figma.variables.getLocalVariablesAsync();
      
      // First pass: create all variables
      for (const variable of variables) {
        // Check if variable exists
        let figmaVariable = figmaVariables
          .find(v => v.name === variable.name && v.variableCollectionId === figmaCollection.id);
        
        // Create variable if it doesn't exist
        if (!figmaVariable) {
          const variableType = determineVariableType(variable.value);
          figmaVariable = figma.variables.createVariable(
            variable.name,
            figmaCollection, // Pass the collection node directly
            variableType
          );
        }
        
        // Store the variable for later reference
        variableMap.set(`--${variable.name}`, figmaVariable);
      }
      
      // Second pass: set values (after all variables are created for aliasing)
      for (const variable of variables) {
        const figmaVariable = variableMap.get(`--${variable.name}`);
        if (figmaVariable) {
          const value = await parseVariableValue(variable.value, figmaVariable.resolvedType, variableMap);
          figmaVariable.setValueForMode(modeId, value);
        }
      }
    }
  }
}

function determineVariableType(value: string): VariableResolvedDataType {
  // Check if it's a reference to another variable
  if (value.startsWith('var(--')) {
    // For references, we'll need to determine the type later
    return 'COLOR'; // Default to color for now
  }
  
  // Check if it's a color
  if (value.startsWith('#') || 
      value.startsWith('rgb') || 
      value.startsWith('rgba') || 
      value.startsWith('hsl') || 
      value.startsWith('hsla')) {
    return 'COLOR';
  }
  
  // Check if it's a number with units (for FLOAT)
  if (/^-?\d+(\.\d+)?(px|rem|em|%|vw|vh|vmin|vmax)$/.test(value)) {
    return 'FLOAT';
  }
  
  // Check if it's a plain number
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return 'FLOAT';
  }
  
  // Default to STRING for anything else
  return 'STRING';
}

async function parseVariableValue(
  value: string, 
  type: VariableResolvedDataType, 
  variableMap: Map<string, Variable>
): Promise<VariableValue> {
  // Handle variable references
  if (value.startsWith('var(--')) {
    const referencedVarName = value.match(/var\(--([^)]+)\)/)?.[1];
    if (referencedVarName) {
      // Find the referenced variable from our map
      const referencedVar = variableMap.get(`--${referencedVarName}`);
      
      if (referencedVar) {
        return {
          type: 'VARIABLE_ALIAS',
          id: referencedVar.id
        };
      }
    }
  }
  
  // Handle direct values based on type
  switch (type) {
    case 'COLOR':
      return parseColorValue(value);
    case 'FLOAT':
      return parseFloatValue(value);
    case 'STRING':
    default:
      return value;
  }
}

function parseColorValue(value: string): RGB | RGBA {
  // Handle hex colors
  if (value.startsWith('#')) {
    return hexToRgb(value);
  }
  
  // Handle rgba colors
  if (value.startsWith('rgba')) {
    const match = value.match(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/);
    if (match) {
      return {
        r: parseInt(match[1]) / 255,
        g: parseInt(match[2]) / 255,
        b: parseInt(match[3]) / 255,
        a: parseFloat(match[4])
      };
    }
  }
  
  // Handle rgb colors
  if (value.startsWith('rgb')) {
    const match = value.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
    if (match) {
      return {
        r: parseInt(match[1]) / 255,
        g: parseInt(match[2]) / 255,
        b: parseInt(match[3]) / 255
      };
    }
  }
  
  // Default fallback
  return { r: 0, g: 0, b: 0 };
}

function hexToRgb(hex: string): RGB | RGBA {
  // Remove # if present
  hex = hex.replace('#', '');
  
  // Handle shorthand hex
  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }
  
  // Handle hex with alpha
  if (hex.length === 8) {
    const r = parseInt(hex.slice(0, 2), 16) / 255;
    const g = parseInt(hex.slice(2, 4), 16) / 255;
    const b = parseInt(hex.slice(4, 6), 16) / 255;
    const a = parseInt(hex.slice(6, 8), 16) / 255;
    return { r, g, b, a };
  }
  
  // Handle standard hex
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  return { r, g, b };
}

function parseFloatValue(value: string): number {
  // Extract just the number part if there are units
  const match = value.match(/^(-?\d+(\.\d+)?)/);
  if (match) {
    return parseFloat(match[1]);
  }
  return 0;
}