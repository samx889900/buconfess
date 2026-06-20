'use client';

import { useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Html, Float, Environment } from '@react-three/drei';
import * as THREE from 'three';

const CONFESSIONS = [
  "Does anyone actually know what's going on in the placements group?",
  "I skipped 8 AM classes for a week and now I'm terrified of the attendance portal.",
  "Library coffee is the only thing keeping my CGPA above a 7.",
  "To the guy who helped me debug my Python code in the lab: thank you.",
  "Is the mess food getting worse or am I just getting tired of it?",
  "My roommate sets 5 alarms and sleeps through all of them.",
  "Imposter syndrome is hitting so hard during these internship tests.",
  "I thought I wanted to do CS until I met Data Structures.",
  "Why is the WiFi always down when I actually want to study?",
  "The walk from the hostel to the academic block is my only cardio.",
  "I pretend to take notes but I'm just stressing over my resume.",
  "I miss my mom's cooking so much it hurts.",
  "Shoutout to the guard bhaiya who always smiles at me.",
  "I spent 5 hours on a project just to realize I missed a semicolon.",
  "We need a better place to get midnight snacks.",
  "Does anyone else feel completely lost about their career?",
  "I think I'm falling for my lab partner, but they graduate next year.",
  "Just saw a peacock on campus, made my whole day.",
  "Grinding LeetCode at 3 AM because I have no idea what else to do.",
  "I actually really love it here, despite the stress."
];

function InteractiveConfession({ item }: { item: any }) {
  const groupRef = useRef<THREE.Group>(null);
  const vec = new THREE.Vector3();
  
  const basePos = useMemo(() => new THREE.Vector3(item.x, item.y, item.z), [item]);
  const currentPos = useMemo(() => new THREE.Vector3(item.x, item.y, item.z), [item]);
  const velocity = useMemo(() => new THREE.Vector3(), []);

  useFrame((state, delta) => {
    if (!groupRef.current) return;
    
    vec.copy(currentPos);
    vec.project(state.camera);
    
    const dx = vec.x - state.pointer.x;
    const dy = vec.y - state.pointer.y;
    const distance = Math.sqrt(dx * dx + (dy * dy * 1.5));
    
    if (distance < 0.65) {
      const force = Math.pow(0.65 - distance, 2) * 10;
      const angle = Math.atan2(dy, dx);
      velocity.x += Math.cos(angle) * force * delta;
      velocity.y += Math.sin(angle) * force * delta;
    }
    
    const springForce = 2.0;
    const damping = 0.86;
    
    velocity.x += (basePos.x - currentPos.x) * springForce * delta;
    velocity.y += (basePos.y - currentPos.y) * springForce * delta;
    velocity.z += (basePos.z - currentPos.z) * springForce * delta;
    
    velocity.multiplyScalar(damping);
    currentPos.add(velocity);
    groupRef.current.position.copy(currentPos);
  });

  return (
    <Float
      rotation={[item.rotX, item.rotY, item.rotZ]}
      speed={item.speed}
      rotationIntensity={0.2}
      floatIntensity={0.4}
      floatingRange={[-0.2, 0.2]}
    >
      <group ref={groupRef}>
        <Html transform center scale={item.scale} zIndexRange={[1, 0]}>
          <div 
            className="w-[380px] bg-white/95 backdrop-blur-md shadow-[0_8px_30px_rgba(0,0,0,0.04)] rounded-2xl border border-gray-100 p-6 font-sans pointer-events-none select-none text-left"
            style={{ opacity: item.opacity }}
          >
            <div className="flex items-center gap-3.5 mb-4">
              <div 
                className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-lg shadow-sm"
                style={{ backgroundColor: item.color }}
              >
                {item.author.charAt(0)}
              </div>
              <div className="flex flex-col">
                <span className="font-bold text-gray-900 text-[15px] tracking-tight">{item.author}</span>
                <span className="text-gray-400 text-[12px] font-medium tracking-wide">{item.time}</span>
              </div>
            </div>
            
            <p className="text-gray-700 text-[15px] font-medium leading-relaxed mb-5">
              {item.text}
            </p>
            
            <div className="flex items-center gap-6 text-gray-400 font-semibold text-[13px]">
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4 text-purple-500" fill="currentColor" viewBox="0 0 20 20"><path d="M2 10.5a1.5 1.5 0 113 0v6a1.5 1.5 0 01-3 0v-6zM6 10.333v5.43a2 2 0 001.106 1.79l.05.025A4 4 0 008.943 18h5.416a2 2 0 001.962-1.608l1.2-6A2 2 0 0015.56 8H12V4a2 2 0 00-2-2 1 1 0 00-1 1v.667a4 4 0 01-.8 2.4L6.8 7.933a4 4 0 00-.8 2.4z" /></svg>
                <span className="text-gray-600">{item.likes}</span>
              </div>
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path d="M18 9.5a1.5 1.5 0 11-3 0v-6a1.5 1.5 0 013 0v6zM14 9.667v-5.43a2 2 0 00-1.105-1.79l-.05-.025A4 4 0 0011.055 2H5.64a2 2 0 00-1.962 1.608l-1.2 6A2 2 0 004.44 12H8v4a2 2 0 002 2 1 1 0 001-1v-.667a4 4 0 01.8-2.4l1.4-1.866a4 4 0 00.8-2.4z" /></svg>
              </div>
              <span className="ml-auto uppercase tracking-wider cursor-pointer font-bold text-[11px] hover:text-purple-600 transition-colors">Reply</span>
            </div>
          </div>
        </Html>
      </group>
    </Float>
  );
}

function FloatingConfessions() {
  const items = useMemo(() => {
    const count = 65;
    // Generate 65 random items, picking random confessions
    const selected = Array.from({ length: count }, () => CONFESSIONS[Math.floor(Math.random() * CONFESSIONS.length)]);

    const NAMES = ["Alex", "Jordan", "Taylor", "Morgan", "Sam", "Casey", "Riley", "Avery"];
    const TIMES = ["a minute ago", "3 minutes ago", "1 hour ago", "Just now", "2 hours ago", "4 hours ago"];
    const COLORS = ["#8B5CF6", "#10B981", "#06B6D4", "#F43F5E", "#F59E0B", "#6366F1"];

    return selected.map((text, i) => {
      // Arrange them in an elegant concentric ring/spiral pattern
      const angle = i * ((Math.PI * 2) / 12); // Spiral angle spread
      const radius = 5 + (i * 0.25); // Expanding outward radially, pushed further out
      
      const x = Math.cos(angle) * radius;
      // Squash the Y axis slightly so it fits screen aspect ratio better
      const y = Math.sin(angle) * (radius * 0.7); 
      // Stagger Z depth significantly to create a dense 3D cloud
      const z = -3 - (Math.random() * 12); 
      
      // Subtle static rotation for organic feel
      const rotX = (Math.random() - 0.5) * 0.1;
      const rotY = (Math.random() - 0.5) * 0.15;
      const rotZ = (Math.random() - 0.5) * 0.05;
      
      const speed = 0.5 + Math.random() * 1.0; // Floating bob speed

      const author = NAMES[Math.floor(Math.random() * NAMES.length)];
      const time = TIMES[Math.floor(Math.random() * TIMES.length)];
      const color = COLORS[Math.floor(Math.random() * COLORS.length)];
      const likes = Math.floor(Math.random() * 500) + 12;
      
      const scale = 0.20 + Math.random() * 0.35;
      const opacity = Math.max(0.15, 1 - (Math.abs(z + 2) / 10)); // Farther cards are more transparent

      return { x, y, z, rotX, rotY, rotZ, speed, text, author, time, color, likes, scale, opacity };
    });
  }, []);

  return (
    <group>
      {items.map((item, i) => (
        <InteractiveConfession key={i} item={item} />
      ))}
    </group>
  );
}

export default function Scene3D() {
  return (
    <div className="absolute inset-0 z-0">
      <Canvas
        camera={{ position: [0, 0, 8], fov: 45 }}
        gl={{ antialias: true, alpha: true }}
        style={{ background: 'transparent' }}
      >
        <ambientLight intensity={1.5} />
        <directionalLight position={[0, 10, 10]} intensity={1.0} color="#FFFFFF" />
        
        <FloatingConfessions />
        
        <Environment preset="city" />
      </Canvas>
    </div>
  );
}
